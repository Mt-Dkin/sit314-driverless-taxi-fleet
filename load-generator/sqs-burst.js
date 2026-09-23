/**
 * sqs-burst.js
 *
 * Week 8 auto-scaling experiment: injects a sustained, controlled rate of
 * realistic taxi telemetry events directly into one microservice's SQS
 * queue. This isolates the microservice layer, so its auto-scaling
 * behaviour can be demonstrated independently of the ingestion layer
 * (a single IoT Core connection is throttled to ~100 publishes/s, and there
 * is a single Node-RED instance - see risk PR003).
 *
 * Usage (from this folder, with Learner Lab credentials exported):
 *   QUEUE=geofencing-tracking RATE=150 DURATION_SEC=600 node sqs-burst.js
 *
 *   QUEUE         geofencing-tracking | dispatch-billing | alerting-maintenance
 *   RATE          target messages per second (default 150)
 *   DURATION_SEC  how long to sustain the load (default 600 = 10 minutes)
 */
const { SQSClient, SendMessageBatchCommand, GetQueueUrlCommand } = require("@aws-sdk/client-sqs");
const crypto = require("crypto");

const QUEUE = process.env.QUEUE || "geofencing-tracking";
const RATE = parseInt(process.env.RATE || "150", 10);
const DURATION_SEC = parseInt(process.env.DURATION_SEC || "600", 10);
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

const TICK_MS = 100;                 // send a slice of the load every 100 ms
const PER_TICK = RATE / (1000 / TICK_MS);
const MAX_IN_FLIGHT = 50;            // cap concurrent SendMessageBatch calls

const client = new SQSClient({ region: REGION }); // one client, reused throughout

// Same schema as the simulator's payload, so consumers process it normally.
function makeEvent(i) {
  const flags = [];
  if (QUEUE === "alerting-maintenance") {
    flags.push(Math.random() < 0.2 ? "SUSPECTED_CRASH" : "LOW_BATTERY");
  }
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
  console.log(`[load] target queue: ${QueueUrl}`);
  console.log(`[load] rate: ${RATE} msg/s for ${DURATION_SEC}s (~${RATE * DURATION_SEC} messages)`);

  let sent = 0;
  let failed = 0;
  let inFlight = 0;
  let carry = 0;
  let counter = 0;
  const startedAt = Date.now();

  async function sendBatch(n) {
    const entries = Array.from({ length: n }, (_, k) => ({
      Id: String(k),
      MessageBody: JSON.stringify(makeEvent(counter++)),
    }));
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
    carry += PER_TICK;
    let toSend = Math.floor(carry);
    carry -= toSend;
    while (toSend > 0) {
      if (inFlight >= MAX_IN_FLIGHT) break; // back off rather than pile up requests
      const n = Math.min(10, toSend);       // SQS batch limit is 10
      toSend -= n;
      sendBatch(n);
    }
  }, TICK_MS);

  const reporter = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    console.log(`[load] t=${elapsed.toFixed(0)}s sent=${sent} failed=${failed} actual_rate=${(sent / elapsed).toFixed(1)} msg/s`);
  }, 10000);

  setTimeout(async () => {
    clearInterval(ticker);
    while (inFlight > 0) await new Promise((r) => setTimeout(r, 100));
    clearInterval(reporter);
    const elapsed = (Date.now() - startedAt) / 1000;
    console.log("----------------------------------------");
    console.log(`[load] finished: sent=${sent} failed=${failed} in ${elapsed.toFixed(0)}s (${(sent / elapsed).toFixed(1)} msg/s)`);
  }, DURATION_SEC * 1000);
}

main().catch((err) => {
  console.error("[load] fatal:", err.message);
  process.exit(1);
});
