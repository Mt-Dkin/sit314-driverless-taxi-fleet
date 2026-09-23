/**
 * Dispatch & Billing Service
 *
 * Consumes ride-lifecycle events (passenger_status changes, ride_id
 * assignment) routed from the Node-RED Event Router. Tracks active rides
 * and produces a simple fare calculation when a ride ends. Writes an
 * immutable event history record for each ride event (DynamoDB in
 * production; in-memory array here for local dev).
 */
const express = require("express");
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3002;
const BASE_FARE = 4.5;
const RATE_PER_KM_MIN = 1.2; // simplified: charged per "tick" of movement while occupied

const activeRides = new Map(); // ride_id -> { vehicle_id, startedAt, ticks }
const eventHistory = []; // stand-in for DynamoDB: Immutable Event History

app.post("/ride-events", (req, res) => {
  const payload = req.body;
  const { ride_id, vehicle_id, passenger_status } = payload;

  eventHistory.push({ ...payload, recorded_at: new Date().toISOString() });

  if (ride_id && passenger_status === "occupied" && !activeRides.has(ride_id)) {
    activeRides.set(ride_id, { vehicle_id, startedAt: Date.now(), ticks: 0 });
  } else if (ride_id && activeRides.has(ride_id)) {
    const ride = activeRides.get(ride_id);
    ride.ticks += 1;
    if (passenger_status === "empty") {
      const fare = Number((BASE_FARE + ride.ticks * RATE_PER_KM_MIN).toFixed(2));
      activeRides.delete(ride_id);
      console.log(`[dispatch-billing] ride ${ride_id} completed. fare=$${fare}`);
      return res.status(200).json({ ok: true, ride_completed: true, fare });
    }
  }

  res.status(200).json({ ok: true, active_rides: activeRides.size });
});

app.get("/health", (_req, res) => res.status(200).json({ status: "healthy", service: "dispatch-billing" }));
app.get("/events", (_req, res) => res.json(eventHistory.slice(-100)));

app.listen(PORT, () => console.log(`[dispatch-billing] listening on ${PORT}`));
