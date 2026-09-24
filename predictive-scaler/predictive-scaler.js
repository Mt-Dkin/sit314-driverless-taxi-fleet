/**
 * predictive-scaler.js
 *
 * Hybrid predictive (proactive) auto-scaler for one ECS microservice.
 * High Distinction research component: compared experimentally against the
 * reactive target-tracking policies used in the Distinction project.
 *
 * Control loop (every INTERVAL_SEC), following the proactive auto-scaling
 * pattern in the literature: observe -> forecast -> plan -> act.
 *
 *   1. OBSERVE   arrival rate from the SQS NumberOfMessagesSent CloudWatch
 *                metric (1-minute resolution), plus queue backlog and tasks.
 *   2. FORECAST  Holt's double exponential smoothing (level + trend, optionally
 *                damped by PHI) predicts
 *                the arrival rate H minutes ahead, where H covers the metric
 *                reporting delay plus task start-up time.
 *   3. PLAN      required tasks = ceil((forecast + backlog/DRAIN_SEC) /
 *                (UTILISATION x PER_TASK_RATE)), clamped to [MIN, MAX].
 *                PER_TASK_RATE (~150 msg/s) was measured in the Distinction
 *                scaling experiments.
 *   4. ACT       sets the service's Application Auto Scaling MinCapacity to
 *                the plan, so capacity is added before the backlog builds.
 *                The reactive target-tracking policies stay attached as a
 *                fall-back for unforecastable surges. MinCapacity is lowered
 *                only after SCALE_DOWN_CONFIRM consecutive lower plans.
 *
 * Every cycle is logged to predictive-<service>-<timestamp>.csv.
 *
 * Usage:  SERVICE=geofencing-tracking node predictive-scaler.js
 *         SIM=1 node predictive-scaler.js   (offline test, no AWS calls)
 */
const fs = require("fs");

// ---------------- configuration ----------------
const SERVICE = process.env.SERVICE || "geofencing-tracking";
const CLUSTER = process.env.CLUSTER || "fleet-cluster";
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const QUEUE_NAME = `fleet-${SERVICE}-queue`;

const INTERVAL_SEC = parseInt(process.env.INTERVAL_SEC || "30", 10);
const PER_TASK_RATE = parseFloat(process.env.PER_TASK_RATE || "150"); // msg/s, measured
const UTILISATION = parseFloat(process.env.UTILISATION || "0.8");     // headroom target
const DRAIN_SEC = parseFloat(process.env.DRAIN_SEC || "60");           // clear backlog within
const MIN_TASKS = parseInt(process.env.MIN_TASKS || "1", 10);
const MAX_TASKS = parseInt(process.env.MAX_TASKS || "5", 10);
const PROVISION_MIN = parseFloat(process.env.PROVISION_MIN || "1");    // task start-up, minutes
const ALPHA = parseFloat(process.env.ALPHA || "0.5");                  // Holt level smoothing
const BETA = parseFloat(process.env.BETA || "0.3");                    // Holt trend smoothing
const PHI = parseFloat(process.env.PHI || "0.8");                      // trend damping (1 = plain Holt)
const SCALE_DOWN_CONFIRM = parseInt(process.env.SCALE_DOWN_CONFIRM || "3", 10);
const SIM = process.env.SIM === "1";

// ---------------- Holt's linear (double exponential) smoothing ----------------
class Holt {
  // Holt's linear method with optional damped trend (phi < 1 flattens the
  // projected trend, reducing overshoot when growth levels off).
  constructor(alpha, beta, phi = 1) { this.alpha = alpha; this.beta = beta; this.phi = phi; this.level = null; this.trend = 0; }
  update(x) {
    if (this.level === null) { this.level = x; this.trend = 0; return; }
    const prevLevel = this.level;
    this.level = this.alpha * x + (1 - this.alpha) * (this.level + this.phi * this.trend);
    this.trend = this.beta * (this.level - prevLevel) + (1 - this.beta) * this.phi * this.trend;
  }
  forecast(h) {
    if (this.level === null) return 0;
    // sum of phi^1..phi^h (equals h when phi = 1); fractional h handled continuously
    const damp = this.phi === 1 ? h : (this.phi * (1 - Math.pow(this.phi, h))) / (1 - this.phi);
    return Math.max(0, this.level + damp * this.trend);
  }
}

// ---------------- capacity model ----------------
function requiredTasks(forecastRate, backlog) {
  const demand = forecastRate + backlog / DRAIN_SEC;
  const n = Math.ceil(demand / (UTILISATION * PER_TASK_RATE));
  return Math.min(MAX_TASKS, Math.max(MIN_TASKS, n));
}

// ---------------- AWS adapters (real or simulated) ----------------
function makeAws() {
  const { CloudWatchClient, GetMetricDataCommand } = require("@aws-sdk/client-cloudwatch");
  const { SQSClient, GetQueueUrlCommand, GetQueueAttributesCommand } = require("@aws-sdk/client-sqs");
  const { ECSClient, DescribeServicesCommand, UpdateServiceCommand } = require("@aws-sdk/client-ecs");
  const { ApplicationAutoScalingClient, RegisterScalableTargetCommand } = require("@aws-sdk/client-application-auto-scaling");
  const cw = new CloudWatchClient({ region: REGION });
  const sqs = new SQSClient({ region: REGION });
  const ecs = new ECSClient({ region: REGION });
  const aas = new ApplicationAutoScalingClient({ region: REGION });
  let queueUrl = null;

  return {
    // Per-minute arrival rates (msg/s) for complete minutes, oldest first.
    async arrivals() {
      const end = new Date(Math.floor(Date.now() / 60000) * 60000); // last complete minute boundary
      const start = new Date(end.getTime() - 15 * 60000);
      const res = await cw.send(new GetMetricDataCommand({
        StartTime: start, EndTime: end, ScanBy: "TimestampAscending",
        MetricDataQueries: [{ Id: "sent", ReturnData: true, MetricStat: {
          Metric: { Namespace: "AWS/SQS", MetricName: "NumberOfMessagesSent", Dimensions: [{ Name: "QueueName", Value: QUEUE_NAME }] },
          Period: 60, Stat: "Sum" } }],
      }));
      const r = res.MetricDataResults[0];
      return (r.Timestamps || []).map((ts, i) => ({ t: new Date(ts).getTime(), rate: r.Values[i] / 60 }));
    },
    async backlog() {
      if (!queueUrl) queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: QUEUE_NAME }))).QueueUrl;
      const a = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["ApproximateNumberOfMessages"] }));
      return parseInt(a.Attributes.ApproximateNumberOfMessages, 10);
    },
    async tasks() {
      const s = (await ecs.send(new DescribeServicesCommand({ cluster: CLUSTER, services: [SERVICE] }))).services[0];
      return { running: s.runningCount, desired: s.desiredCount };
    },
    async setMin(n) {
      await aas.send(new RegisterScalableTargetCommand({
        ServiceNamespace: "ecs", ResourceId: `service/${CLUSTER}/${SERVICE}`,
        ScalableDimension: "ecs:service:DesiredCount", MinCapacity: n, MaxCapacity: MAX_TASKS,
      }));
    },
    // Only used if a raised minimum hasn't lifted the desired count yet.
    async setDesired(n) {
      await ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service: SERVICE, desiredCount: n }));
    },
  };
}

// Offline simulation: a ramp from 50 to 300 msg/s, CloudWatch-style 2-minute
// reporting delay, and a crude queue/task model. Used only to test the logic.
function makeSim() {
  const t0 = Date.now();
  let simMin = 0, backlog = 0, desired = 1, running = 1, minCap = 1;
  const rateAt = (m) => (m < 2 ? 50 : m < 12 ? 50 + 25 * (m - 2) : m < 17 ? 300 : Math.max(50, 300 - 125 * (m - 17)));
  return {
    advance() {
      simMin += INTERVAL_SEC / 60;
      running = desired; // assume tasks start within an interval
      backlog = Math.max(0, backlog + (rateAt(simMin) - running * PER_TASK_RATE) * INTERVAL_SEC);
      return simMin;
    },
    async arrivals() {
      const visible = Math.floor(simMin) - 2; // 2-minute metric delay
      const out = [];
      for (let m = Math.max(0, visible - 14); m <= visible; m++) out.push({ t: t0 + m * 60000, rate: rateAt(m) });
      return out;
    },
    async backlog() { return Math.round(backlog); },
    async tasks() { return { running, desired }; },
    async setMin(n) { minCap = n; if (desired < n) desired = n; },
    async setDesired(n) { desired = n; },
    trueRate: () => rateAt(simMin),
  };
}

// ---------------- main loop ----------------
async function main() {
  const aws = SIM ? makeSim() : makeAws();
  const holt = new Holt(ALPHA, BETA, PHI);
  let lastSeen = 0, currentMin = MIN_TASKS, lowerStreak = 0;

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const logFile = `predictive-${SERVICE}-${SIM ? "SIM-" : ""}${stamp}.csv`;
  fs.writeFileSync(logFile, "time,latest_rate,metric_age_min,level,trend,horizon_min,forecast_rate,backlog,running,desired,planned,min_capacity,action\n");
  console.log(`[predictive] service=${SERVICE} interval=${INTERVAL_SEC}s mu=${PER_TASK_RATE} rho=${UTILISATION} alpha=${ALPHA} beta=${BETA} phi=${PHI}`);
  console.log(`[predictive] logging to ${logFile}`);

  if (!SIM) await aws.setMin(MIN_TASKS); // start from a known state

  const cycle = async () => {
    const now = SIM ? Date.now() + aws.advance() * 60000 : Date.now();
    const points = await aws.arrivals();
    for (const p of points) if (p.t > lastSeen) { holt.update(p.rate); lastSeen = p.t; }

    const latest = points.length ? points[points.length - 1] : null;
    const ageMin = latest ? (SIM ? 2 : (now - latest.t) / 60000) : 0;
    const horizon = ageMin + PROVISION_MIN;
    const forecast = holt.forecast(horizon);
    const backlog = await aws.backlog();
    const { running, desired } = await aws.tasks();
    const planned = requiredTasks(forecast, backlog);

    let action = "hold";
    if (planned > currentMin) {
      currentMin = planned; lowerStreak = 0;
      await aws.setMin(currentMin);
      if (desired < currentMin) await aws.setDesired(currentMin);
      action = `raise_min_${currentMin}`;
    } else if (planned < currentMin) {
      lowerStreak++;
      if (lowerStreak >= SCALE_DOWN_CONFIRM) {
        currentMin = planned; lowerStreak = 0;
        await aws.setMin(currentMin); // reactive scale-in policy then removes spare tasks
        action = `lower_min_${currentMin}`;
      } else action = `lower_pending_${lowerStreak}`;
    } else lowerStreak = 0;

    const row = [new Date(now).toTimeString().slice(0, 8), latest ? latest.rate.toFixed(1) : "", ageMin.toFixed(1),
      (holt.level ?? 0).toFixed(1), holt.trend.toFixed(2), horizon.toFixed(1), forecast.toFixed(1),
      backlog, running, desired, planned, currentMin, action];
    fs.appendFileSync(logFile, row.join(",") + "\n");
    console.log(`[predictive] ${row[0]} obs=${row[1]} fc=${row[6]} (h=${row[5]}m) backlog=${backlog} tasks=${running}/${desired} plan=${planned} min=${currentMin} ${action}` +
      (SIM ? ` true_now=${aws.trueRate().toFixed(0)}` : ""));
  };

  if (SIM) {
    for (let i = 0; i < 44; i++) await cycle(); // ~22 simulated minutes
    console.log("[predictive] simulation complete");
    return;
  }

  // Graceful stop: restore the normal minimum so reactive scaling runs alone.
  process.on("SIGINT", async () => {
    console.log(`\n[predictive] stopping: restoring MinCapacity=${MIN_TASKS}`);
    try { await aws.setMin(MIN_TASKS); } catch (e) { console.error(e.message); }
    process.exit(0);
  });

  await cycle();
  setInterval(() => cycle().catch((e) => console.error(`[predictive] cycle error: ${e.message}`)), INTERVAL_SEC * 1000);
}

main().catch((e) => { console.error("[predictive] fatal:", e.message); process.exit(1); });
