// The snapshotter for one room. Settings come from the same CANVAS_*
// variables as the gateway, with its own token; see docs/development.md.
import { createServer } from "node:http";

import felix from "felix-client";

import { Snapshotter, type RoomLog } from "./snapshotter.js";

const env = (name: string, fallback: string): string => process.env[name] || fallback;

const token = env("CANVAS_FELIX_TOKEN", "");
if (!token) {
  console.error("CANVAS_FELIX_TOKEN must be set to the snapshotter's Felix token");
  process.exit(1);
}
const tenant = env("CANVAS_TENANT", "canvas");
const namespace = env("CANVAS_NAMESPACE", "default");
const room = env("CANVAS_ROOM", "lobby");
const [host, port] = env("CANVAS_SNAPSHOTTER_LISTEN", "127.0.0.1:8788").split(":");
const ops = `canvas.ops.${room}`;
const group = "snapshotter";

const client = await felix.Client.connect(
  env("CANVAS_FELIX_BROKERS", "127.0.0.1:5000").split(","),
  tenant,
  token,
  env("CANVAS_FELIX_SERVER_NAME", "localhost"),
  process.env.CANVAS_FELIX_CA_FILE || undefined,
);

const log: RoomLog = {
  poll: (max, waitMs) => client.groupPoll(tenant, namespace, ops, 0, group, max, waitMs),
  ack: (offset) => client.groupAck(tenant, namespace, ops, 0, group, offset),
  readSnapshot: () => client.cacheGet(tenant, namespace, "canvas.snap", room),
  writeSnapshot: (bytes) =>
    client.cachePut(tenant, namespace, "canvas.snap", room, Buffer.from(bytes)),
};
const snapshotter = new Snapshotter(log, {
  everyOps: Number(env("CANVAS_SNAPSHOT_EVERY_OPS", "500")),
  everyMs: Number(env("CANVAS_SNAPSHOT_EVERY_MS", "30000")),
});

createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ room, ...snapshotter.position }));
}).listen(Number(port), host, () =>
  console.log(`snapshotter for ${room} serving its position on ${host}:${port}`),
);

await snapshotter.start();
// Records a previous run claimed and never acknowledged stay claimed until
// the group's visibility timeout lapses, and newer records would be handed out
// ahead of them. Waiting it out first means they come back before anything
// newer, so the fold stays in offset order.
await new Promise((resolve) =>
  setTimeout(resolve, Number(env("CANVAS_SNAPSHOTTER_CLAIM_WAIT_MS", "30000"))),
);

for (;;) {
  try {
    await snapshotter.step(1000);
  } catch (err) {
    // Whatever was not acknowledged is handed out again, so waiting and
    // carrying on loses nothing.
    console.error(`snapshotter: ${String(err)}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
