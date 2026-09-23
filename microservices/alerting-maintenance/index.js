/**
 * Alerting & Maintenance Service
 *
 * Consumes hazard/battery events (status_flags such as SUSPECTED_CRASH or
 * LOW_BATTERY) routed from the Node-RED Event Router (via its own SQS
 * queue in AWS). In production this would page a human operator / trigger
 * a route-redirection actuator command back to the vehicle; here it logs
 * and exposes an alert feed.
 */
const express = require("express");
const { startSqsConsumer } = require("../shared/sqs-consumer");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3003;
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const alerts = [];

function processHazard(payload) {
  const flags = payload.status_flags || [];
  if (flags.length === 0) {
    return { ok: true, alert_raised: false };
  }

  const alert = {
    vehicle_id: payload.vehicle_id,
    flags,
    coordinates: payload.coordinates,
    raised_at: new Date().toISOString(),
    severity: flags.includes("SUSPECTED_CRASH") ? "CRITICAL" : "WARNING",
  };
  alerts.push(alert);
  console.warn(`[alerting-maintenance] ${alert.severity} alert for ${alert.vehicle_id}: ${flags.join(",")}`);
  return { ok: true, alert_raised: true, severity: alert.severity };
}

app.post("/hazards", (req, res) => {
  res.status(200).json(processHazard(req.body));
});

app.get("/health", (_req, res) => res.status(200).json({ status: "healthy", service: "alerting-maintenance" }));
app.get("/alerts", (_req, res) => res.json(alerts.slice(-100)));

app.listen(PORT, () => console.log(`[alerting-maintenance] listening on ${PORT}`));

startSqsConsumer({
  queueUrl: SQS_QUEUE_URL,
  region: AWS_REGION,
  logPrefix: "[alerting-maintenance]",
  handler: async (payload) => processHazard(payload),
});
