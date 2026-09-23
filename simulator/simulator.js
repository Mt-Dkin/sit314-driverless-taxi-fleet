/**
 * simulator.js
 *
 * Edge Layer: Simulated Fleet (see Figure 1, High-Level Block Diagram).
 *
 * Spins up N virtual autonomous taxis. Each taxi is an independent "edge
 * node" that:
 *   - Moves around a bounded region of Melbourne (random walk)
 *   - Generates a JSON telemetry payload matching the Data Design schema
 *   - Publishes that payload over MQTT to a broker (local broker for dev,
 *     AWS IoT Core endpoint for the cloud-deployed version)
 *   - Occasionally raises event flags (SUSPECTED_CRASH) when a sudden speed
 *     drop coincides with a proximity-sensor warning, per the "Event
 *     flagging" behaviour described in the proposal
 *
 * Config is via environment variables so the same script can point at the
 * local broker or AWS IoT Core without code changes:
 *   FLEET_SIZE       number of virtual taxis (default 10)
 *   PUBLISH_HZ       publish rate per vehicle in Hz (default 1)
 *   MQTT_URL         broker URL (default mqtt://localhost:1883)
 *   MQTT_USERNAME / MQTT_PASSWORD / MQTT_CA_CERT (for AWS IoT Core, use
 *     mutual TLS certs instead - see docs/aws-iot-core-setup.md)
 */
require("dotenv").config();
const mqtt = require("mqtt");
const crypto = require("crypto");

const FLEET_SIZE = parseInt(process.env.FLEET_SIZE || "10", 10);
const PUBLISH_HZ = parseFloat(process.env.PUBLISH_HZ || "1");
const MQTT_URL = process.env.MQTT_URL || "mqtt://localhost:1883";
const PUBLISH_INTERVAL_MS = 1000 / PUBLISH_HZ;

// Melbourne CBD bounding box, roughly.
const BOUNDS = { latMin: -37.825, latMax: -37.805, lngMin: 144.945, lngMax: 144.975 };

function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

class VirtualTaxi {
  constructor(id) {
    this.vehicleId = `taxi-${String(id).padStart(4, "0")}`;
    this.lat = randomInRange(BOUNDS.latMin, BOUNDS.latMax);
    this.lng = randomInRange(BOUNDS.lngMin, BOUNDS.lngMax);
    this.speed = randomInRange(0, 60);
    this.battery = randomInRange(40, 100);
    this.passengerStatus = "empty";
    this.rideId = null;
    this.idleTicks = 0;
    this.lastProximityWarning = false;
  }

  // Random-walk the vehicle's position and mechanical state each tick.
  tick() {
    // Movement
    this.lat += randomInRange(-0.0006, 0.0006);
    this.lng += randomInRange(-0.0006, 0.0006);
    this.lat = Math.min(Math.max(this.lat, BOUNDS.latMin), BOUNDS.latMax);
    this.lng = Math.min(Math.max(this.lng, BOUNDS.lngMin), BOUNDS.lngMax);

    // Speed - occasionally idle, occasionally a sharp drop (for event flagging demo)
    const roll = Math.random();
    let sharpDrop = false;
    if (roll < 0.03) {
      this.speed = 0; // idle
    } else if (roll < 0.05) {
      sharpDrop = this.speed > 20;
      this.speed = Math.max(0, this.speed - randomInRange(15, 40)); // sudden braking
    } else {
      this.speed = Math.min(80, Math.max(0, this.speed + randomInRange(-5, 5)));
    }

    this.idleTicks = this.speed === 0 ? this.idleTicks + 1 : 0;

    // Battery drains slowly
    this.battery = Math.max(0, this.battery - randomInRange(0, 0.05));

    // Passenger / ride lifecycle
    if (this.passengerStatus === "empty" && Math.random() < 0.02) {
      this.passengerStatus = "occupied";
      this.rideId = crypto.randomUUID();
    } else if (this.passengerStatus === "occupied" && Math.random() < 0.02) {
      this.passengerStatus = "empty";
      this.rideId = null;
    }

    // Proximity sensor: small chance of a warning
    const proximityWarning = Math.random() < 0.04;
    this.lastProximityWarning = proximityWarning;

    // Event flagging: sharp speed drop + proximity warning => SUSPECTED_CRASH
    const statusFlags = [];
    if (sharpDrop && proximityWarning) statusFlags.push("SUSPECTED_CRASH");
    if (this.battery < 15) statusFlags.push("LOW_BATTERY");
    if (this.idleTicks >= 5) statusFlags.push("IDLE_STATE");

    return {
      vehicle_id: this.vehicleId,
      ride_id: this.rideId,
      timestamp: new Date().toISOString(),
      coordinates: { lat: Number(this.lat.toFixed(6)), lng: Number(this.lng.toFixed(6)) },
      speed: Number(this.speed.toFixed(1)),
      battery_percentage: Number(this.battery.toFixed(1)),
      passenger_status: this.passengerStatus,
      proximity_warning: proximityWarning,
      status_flags: statusFlags,
    };
  }
}

function main() {
  console.log(`[simulator] connecting to ${MQTT_URL} ...`);
  const client = mqtt.connect(MQTT_URL, {
    clientId: `fleet-simulator-${crypto.randomBytes(4).toString("hex")}`,
    reconnectPeriod: 2000,
  });

  const fleet = Array.from({ length: FLEET_SIZE }, (_, i) => new VirtualTaxi(i + 1));
  let publishedTotal = 0;

  client.on("connect", () => {
    console.log(`[simulator] connected. Publishing ${FLEET_SIZE} vehicles at ${PUBLISH_HZ}Hz each.`);

    setInterval(() => {
      for (const taxi of fleet) {
        const payload = taxi.tick();
        const topic = `fleet/${payload.vehicle_id}/telemetry`;
        client.publish(topic, JSON.stringify(payload), { qos: 0 });
        publishedTotal++;

        if (payload.status_flags.length > 0) {
          console.log(`[simulator] ${payload.vehicle_id} flags=${payload.status_flags.join(",")}`);
        }
      }
    }, PUBLISH_INTERVAL_MS);

    setInterval(() => {
      console.log(`[simulator] total published: ${publishedTotal}`);
    }, 5000);
  });

  client.on("error", (err) => console.error("[simulator] mqtt error:", err.message));
  client.on("reconnect", () => console.log("[simulator] reconnecting..."));
}

main();
