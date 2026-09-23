/**
 * stress-test.js
 *
 * Local-only load test (PR002 mitigation): uses Node.js worker_threads so
 * message generation runs in parallel to the main event loop, avoiding the
 * single-threaded bottleneck that would otherwise skew results.
 *
 * Spins up `WORKERS` worker threads, each simulating `FLEET_PER_WORKER`
 * taxis, and reports aggregate publish throughput. Use this to baseline
 * Node-RED / broker throughput locally BEFORE running the equivalent test
 * against AWS IoT Core in Weeks 7-8.
 *
 * Usage: WORKERS=4 FLEET_PER_WORKER=25 DURATION_SEC=30 node stress-test.js
 */
const { Worker, isMainThread, workerData, parentPort } = require("worker_threads");
const path = require("path");

const WORKERS = parseInt(process.env.WORKERS || "4", 10);
const FLEET_PER_WORKER = parseInt(process.env.FLEET_PER_WORKER || "25", 10);
const DURATION_SEC = parseInt(process.env.DURATION_SEC || "30", 10);
const MQTT_URL = process.env.MQTT_URL || "mqtt://localhost:1883";

if (isMainThread) {
  console.log(`[stress-test] ${WORKERS} workers x ${FLEET_PER_WORKER} vehicles = ${WORKERS * FLEET_PER_WORKER} total vehicles`);
  console.log(`[stress-test] duration=${DURATION_SEC}s target=${MQTT_URL}`);

  let totalPublished = 0;
  let finished = 0;
  const startedAt = Date.now();

  for (let i = 0; i < WORKERS; i++) {
    const worker = new Worker(__filename, {
      workerData: { workerId: i, fleetSize: FLEET_PER_WORKER, durationSec: DURATION_SEC, mqttUrl: MQTT_URL },
    });
    worker.on("message", (msg) => {
      if (msg.type === "done") {
        totalPublished += msg.count;
        finished++;
        console.log(`[stress-test] worker ${msg.workerId} published ${msg.count} messages`);
        if (finished === WORKERS) {
          const elapsedSec = (Date.now() - startedAt) / 1000;
          console.log("----------------------------------------");
          console.log(`[stress-test] TOTAL messages: ${totalPublished}`);
          console.log(`[stress-test] elapsed: ${elapsedSec.toFixed(1)}s`);
          console.log(`[stress-test] throughput: ${(totalPublished / elapsedSec).toFixed(1)} msg/s`);
        }
      }
    });
    worker.on("error", (err) => console.error(`[stress-test] worker ${i} error:`, err));
  }
} else {
  // Worker thread: run its own MQTT client + slice of the fleet.
  const mqtt = require("mqtt");
  const { workerId, fleetSize, durationSec, mqttUrl } = workerData;
  const client = mqtt.connect(mqttUrl, { clientId: `stress-worker-${workerId}` });
  let count = 0;

  client.on("connect", () => {
    const interval = setInterval(() => {
      for (let v = 0; v < fleetSize; v++) {
        const payload = {
          vehicle_id: `stress-${workerId}-${v}`,
          timestamp: new Date().toISOString(),
          coordinates: { lat: -37.81 + Math.random() * 0.01, lng: 144.96 + Math.random() * 0.01 },
          speed: Math.random() * 60,
          battery_percentage: Math.random() * 100,
          passenger_status: Math.random() > 0.5 ? "occupied" : "empty",
          status_flags: [],
        };
        client.publish(`fleet/${payload.vehicle_id}/telemetry`, JSON.stringify(payload), { qos: 0 });
        count++;
      }
    }, 1000);

    setTimeout(() => {
      clearInterval(interval);
      client.end();
      parentPort.postMessage({ type: "done", workerId, count });
    }, durationSec * 1000);
  });
}
