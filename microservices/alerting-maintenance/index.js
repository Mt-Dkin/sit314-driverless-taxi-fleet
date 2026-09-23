/**
 * Alerting & Maintenance Service
 *
 * Consumes hazard/battery events (status_flags such as SUSPECTED_CRASH or
 * LOW_BATTERY) routed from the Node-RED Event Router. In production this
 * would page a human operator / trigger a route-redirection actuator
 * command back to the vehicle; here it logs and exposes an alert feed.
 */
const express = require("express");
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3003;
const alerts = [];

app.post("/hazards", (req, res) => {
  const payload = req.body;
  const flags = payload.status_flags || [];

  if (flags.length === 0) {
    return res.status(200).json({ ok: true, alert_raised: false });
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

  res.status(200).json({ ok: true, alert_raised: true, severity: alert.severity });
});

app.get("/health", (_req, res) => res.status(200).json({ status: "healthy", service: "alerting-maintenance" }));
app.get("/alerts", (_req, res) => res.json(alerts.slice(-100)));

app.listen(PORT, () => console.log(`[alerting-maintenance] listening on ${PORT}`));
