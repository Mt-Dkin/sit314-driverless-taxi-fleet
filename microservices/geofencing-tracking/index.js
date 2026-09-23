/**
 * Geofencing & Tracking Service
 *
 * Consumes location telemetry routed from the Node-RED Event Router.
 * Maintains live vehicle state (for MongoDB "Live State Tracking") and
 * checks each position against configured virtual boundaries (geofences).
 */
const express = require("express");
const { MongoClient } = require("mongodb");
const { startSqsConsumer } = require("../shared/sqs-consumer");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "fleet";
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL; // set in AWS (Terraform); unset locally
const AWS_REGION = process.env.AWS_REGION || "us-east-1";

// Example virtual boundary: Melbourne CBD operating zone.
const GEOFENCE = { latMin: -37.825, latMax: -37.805, lngMin: 144.945, lngMax: 144.975 };

let db;

async function connectMongo() {
  const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 2000 });
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection("vehicle_state").createIndex({ location: "2dsphere" });
  console.log(`[geofencing-tracking] connected to MongoDB (${DB_NAME})`);
}

function isInsideGeofence(lat, lng) {
  return lat >= GEOFENCE.latMin && lat <= GEOFENCE.latMax && lng >= GEOFENCE.lngMin && lng <= GEOFENCE.lngMax;
}

async function processTelemetry(payload) {
  const { lat, lng } = payload.coordinates || {};
  const inside = lat !== undefined ? isInsideGeofence(lat, lng) : null;

  const doc = {
    ...payload,
    inside_geofence: inside,
    updated_at: new Date(),
  };

  if (db) {
    await db.collection("vehicle_state").updateOne(
      { vehicle_id: payload.vehicle_id },
      { $set: doc },
      { upsert: true }
    );
  }
  if (inside === false) {
    console.warn(`[geofencing-tracking] ${payload.vehicle_id} has left the operating zone`);
  }
  return { ok: true, inside_geofence: inside };
}

// HTTP path: used for local dev via docker-compose, and can also serve as
// a direct-invoke path if ever needed. In AWS, the SQS consumer below is
// the primary (event-driven) ingestion path.
app.post("/telemetry", async (req, res) => {
  try {
    const result = await processTelemetry(req.body);
    res.status(200).json(result);
  } catch (err) {
    console.error("[geofencing-tracking] error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/health", (_req, res) => res.status(200).json({ status: "healthy", service: "geofencing-tracking" }));

app.get("/vehicles", async (_req, res) => {
  if (!db) return res.json([]);
  const vehicles = await db.collection("vehicle_state").find({}).limit(100).toArray();
  res.json(vehicles);
});

// Start the HTTP server immediately - don't block API availability on Mongo.
app.listen(PORT, () => console.log(`[geofencing-tracking] listening on ${PORT}`));

connectMongo().catch((err) => {
  console.warn(`[geofencing-tracking] MongoDB unavailable, running without persistence: ${err.message}`);
});

// Event-driven ingestion path (AWS): consumes location events straight
// off this service's own SQS queue, independent of the other services.
startSqsConsumer({
  queueUrl: SQS_QUEUE_URL,
  region: AWS_REGION,
  logPrefix: "[geofencing-tracking]",
  handler: processTelemetry,
});
