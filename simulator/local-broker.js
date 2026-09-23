/**
 * local-broker.js
 *
 * Minimal local MQTT broker used ONLY for local development and load-testing
 * before wiring the simulator to AWS IoT Core. Mirrors the "MQTT/WSS -> AWS
 * API Gateway/IoT Core" edge of the block diagram in the project proposal.
 *
 * Run with: npm run broker
 */
const aedes = require("aedes")();
const net = require("net");
const { createServer } = require("http");
const ws = require("websocket-stream");

const MQTT_PORT = process.env.MQTT_PORT || 1883;
const WS_PORT = process.env.WS_PORT || 8883;

let messageCount = 0;
const startedAt = Date.now();

const server = net.createServer(aedes.handle);
server.listen(MQTT_PORT, () => {
  console.log(`[broker] MQTT listening on port ${MQTT_PORT}`);
});

// WebSocket transport too, since the block diagram specifies MQTT/WSS
const httpServer = createServer();
ws.createServer({ server: httpServer }, aedes.handle);
httpServer.listen(WS_PORT, () => {
  console.log(`[broker] MQTT-over-WebSocket listening on port ${WS_PORT}`);
});

aedes.on("client", (client) => {
  console.log(`[broker] client connected: ${client.id}`);
});

aedes.on("clientDisconnect", (client) => {
  console.log(`[broker] client disconnected: ${client.id}`);
});

aedes.on("publish", (packet, client) => {
  if (client && !packet.topic.startsWith("$SYS")) {
    messageCount++;
  }
});

// Print a simple throughput line every 5s - useful for baselining Node-RED /
// broker throughput ahead of the Week 7-8 AWS stress tests.
setInterval(() => {
  const elapsedSec = (Date.now() - startedAt) / 1000;
  const rate = (messageCount / elapsedSec).toFixed(2);
  console.log(`[broker] total=${messageCount} msgs, avg_rate=${rate} msg/s`);
}, 5000);
