/**
 * sqs-burst.js (v2)
 *
 * Injects realistic taxi telemetry events directly into one microservice's
 * SQS queue, isolating the microservice layer for scaling experiments.
 *
 * v2 adds time-varying load profiles for the High Distinction experiments
 * (reactive vs predictive auto-scaling), and writes a ground-truth log of
 * the rate actually sent every 10 s, used to measure forecast accuracy.
 *
 * Usage (from this folder, with Learner Lab credentials configured):
 *   PROFILE=ramp QUEUE=geofencing-tracking node sqs-burst.js
 *
 * Profiles (all rates in messages per second):
 *   constant  RATE for DURATION_SEC                         (Distinction runs)
 *   ramp      "peak hour": BASE for 2 min, rises linearly to PEAK over
 *             RAMP_SEC, holds PEAK for HOLD_SEC, falls back to BASE over 2 min
 *   step      BASE for 3 min, jumps to PEAK for HOLD_SEC, back to BASE for 3 min
 *   wave      sinusoid between BASE and PEAK, period PERIOD_SEC, for CYCLES cycles
 *
 * Other settings:
 *   QUEUE         geofencing-tracking | dispatch-billing | alerting-maintenance
 *   BASE / PEAK   default 50 / 300 msg/s (one task handles ~150 msg/s, so the
 *                 peak needs 2-3 tasks: room for proportional scaling)
 *   NOISE         random variation as a fraction, default 0.05 (+/-5%)
 *   DRY_RUN=1     print the planned schedule and exit without sending anything
 */
const fs = require("fs");
const crypto = require("crypto");

const QUEUE = process.env.QUEUE || "geofencing-tracking";
const PROFILE = process.env.PROFILE || "constant";
const RATE = parseFloat(process.env.RATE || "150");
const BASE = parseFloat(process.env.BASE || "50");
const PEAK = parseFloat(process.env.PEAK || "300");
const RAMP_SEC = parseInt(process.env.RAMP_SEC || "600", 10);
const HOLD_SEC = parseInt(process.env.HOLD_SEC || "300", 10);
const PERIOD_SEC = parseInt(process.env.PERIOD_SEC || "480", 10);
const CYCLES = parseFloat(process.env.CYCLES || "3");
const NOISE = parseFloat(process.env.NOISE || "0.05");
const DRY_RUN = process.env.DRY_RUN === "1";
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

const TICK_MS = 100;
const MAX_IN_FLIGHT = 50;

// ---------------------------------------------------------------------------
// Load profiles: each returns { durationSec, rateAt(tSec) }
// ---------------------------------------------------------------------------
function buildProfile() {
  switch (PROFILE) {
    case "constant": {
      const d = parseInt(process.env.DURATION_SEC || "600", 10);
      return { durationSec: d, rateAt: () => RATE };
    }
    case "ramp": {
      const lead = 120, fall = 120;
      const d = lead + RAMP_SEC + HOLD_SEC + fall;
      return {
        durationSec: d,
        rateAt: (t) => {
          if (t < lead) return BASE;
          if (t < lead + RAMP_SEC) return BASE + (PEAK - BASE) * ((t - lead) / RAMP_SEC);
          if (t < lead + RAMP_SEC + HOLD_SEC) return PEAK;
          return PEAK - (PEAK - BASE) * Math.min(1, (t - lead - RAMP_SEC - HOLD_SEC) / fall);
        },
      };
    }
    case "step": {
      const lead = 180, tail = 180;
      return {
        durationSec: lead + HOLD_SEC + tail,
        rateAt: (t) => (t >= lead && t < lead + HOLD_SEC ? PEAK : BASE),
      };
    }
    case "wave": {
      const mid = (BASE + PEAK) / 2, amp = (PEAK - BASE) / 2;
      return {
        durationSec: Math.round(PERIOD_SEC * CYCLES),
        // starts at BASE (trough) so every run begins from low load
        rateAt: (t) => mid - amp * Math.cos((2 * Math.PI * t) / PERIOD_SEC),
      };
    }
    default:
      throw new Error(`Unknown PROFILE "${PROFILE}" (use constant, ramp, step or wave)`);
  }
}

const profile = buildProfile();
const withNoise = (r) => Math.max(0, r * (1 + (Math.random() * 2 - 1) * NOISE));

if (DRY_RUN) {
  console.log(`[load] DRY RUN profile=${PROFILE} duration=${profile.durationSec}s`);
  let total = 0;
  for (let t = 0; t < profile.durationSec; t += 30) {
    const r = profile.rateAt(t);
    total += r * 30;
    const bar = "#".repeat(Math.round(r / 10));
    console.log(`t=${String(t).padStart(4)}s  ${r.toFixed(0).padStart(4)} msg/s  ${bar}`);
  }
  console.log(`[load] approx. total messages: ${Math.round(total)}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Sending (only loaded when actually running)
// ---------------------------------------------------------------------------
const { SQSClient, SendMessageBatchCommand, GetQueueUrlCommand } = require("@aws-sdk/client-sqs");
const client = new SQSClient({ region: REGION });

function makeEvent(i) {
  const flags = [];
  if (QUEUE === "alerting-maintenance") flags.push(Math.random() < 0.2 ? "SUSPECTED_CRASH" : "LOW_BATTERY");
  return {
    vehicle_id: `load-${String(i % 500).padStart(4, "0")}`,
    ride_id: QUEUE === "dispatch-billing" ? crypto.randomUUID() : null,
    timestamp: new Date().toISOString(),
    coordinates: { lat: -37.825 + Math.random() * 0.02, lng: 144.945 + Math.random() * 0.03 },
    speed: Number((Math.random() * 60).toFixed(1)),
    battery_percentage: Number((20 + Math.random() * 80).toFixed(1)),
    passenger_status: QUEUE === "dispatch-billing" ? "occupied" : "empty",
    proximity_warning: false,
    status_flags: flags,
    load_test: true,
  };
}

async function main() {
  const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: `fleet-${QUEUE}-queue` }));
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const logFile = `load-${PROFILE}-${stamp}.csv`;
  fs.writeFileSync(logFile, "time,elapsed_s,target_rate,sent_rate,sent_total,failed_total\n");
  console.log(`[load] queue: ${QueueUrl}`);
  console.log(`[load] profile=${PROFILE} duration=${profile.durationSec}s  log -> ${logFile}`);

  let sent = 0, failed = 0, inFlight = 0, carry = 0, counter = 0, sentAtLastLog = 0;
  const startedAt = Date.now();
  const elapsed = () => (Date.now() - startedAt) / 1000;

  async function sendBatch(n) {
    const entries = Array.from({ length: n }, (_, k) => ({ Id: String(k), MessageBody: JSON.stringify(makeEvent(counter++)) }));
    inFlight++;
    try {
      const res = await client.send(new SendMessageBatchCommand({ QueueUrl, Entries: entries }));
      sent += (res.Successful || []).length;
      failed += (res.Failed || []).length;
    } catch (err) {
      failed += n;
      console.error(`[load] batch failed: ${err.message}`);
    } finally {
      inFlight--;
    }
  }

  const ticker = setInterval(() => {
    const target = withNoise(profile.rateAt(elapsed()));
    carry += target * (TICK_MS / 1000);
    let toSend = Math.floor(carry);
    carry -= toSend;
    while (toSend > 0 && inFlight < MAX_IN_FLIGHT) {
      const n = Math.min(10, toSend); // SQS batch limit
      toSend -= n;
      sendBatch(n);
    }
  }, TICK_MS);

  // Ground-truth log every 10 s: the planned rate and the rate actually sent
  const logger = setInterval(() => {
    const t = elapsed();
    const sentRate = (sent - sentAtLastLog) / 10;
    sentAtLastLog = sent;
    const line = `${new Date().toTimeString().slice(0, 8)},${t.toFixed(0)},${profile.rateAt(t).toFixed(1)},${sentRate.toFixed(1)},${sent},${failed}`;
    fs.appendFileSync(logFile, line + "\n");
    console.log(`[load] t=${t.toFixed(0)}s target=${profile.rateAt(t).toFixed(0)} sent=${sentRate.toFixed(0)} msg/s total=${sent} failed=${failed}`);
  }, 10000);

  setTimeout(async () => {
    clearInterval(ticker);
    while (inFlight > 0) await new Promise((r) => setTimeout(r, 100));
    clearInterval(logger);
    console.log("----------------------------------------");
    console.log(`[load] finished: profile=${PROFILE} sent=${sent} failed=${failed} in ${elapsed().toFixed(0)}s`);
  }, profile.durationSec * 1000);
}

main().catch((err) => {
  console.error("[load] fatal:", err.message);
  process.exit(1);
});
