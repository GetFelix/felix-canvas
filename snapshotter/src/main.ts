// Keeps a snapshot of every room in CANVAS_ROOMS, with one Snapshotter per
// room. Settings come from the same CANVAS_* variables as the gateway, plus
// its own token; see docs/self-hosting.md.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import felix from "felix-client";

import { Snapshotter, type RoomLog } from "./snapshotter.js";

const env = (name: string, fallback: string): string => process.env[name] || fallback;

const tokenFile = env("CANVAS_FELIX_TOKEN_FILE", "");
const token = tokenFile ? readFileSync(tokenFile, "utf8").trim() : env("CANVAS_FELIX_TOKEN", "");
if (!token) {
  console.error(
    "Set CANVAS_FELIX_TOKEN or CANVAS_FELIX_TOKEN_FILE to the snapshotter's Felix token",
  );
  process.exit(1);
}
const tenant = env("CANVAS_TENANT", "canvas");
const namespace = env("CANVAS_NAMESPACE", "default");
// The seed's `room=member,member` list, separated by spaces. Only the names matter here.
const rooms = env("CANVAS_ROOMS", "lobby")
  .split(/\s+/)
  .filter(Boolean)
  .map((entry) => entry.split("=")[0]!);
const [host, port] = env("CANVAS_SNAPSHOTTER_LISTEN", "127.0.0.1:8788").split(":");
const snapshotKey = "latest";
const group = "snapshotter";

const client = await felix.Client.connect(
  env("CANVAS_FELIX_BROKERS", "127.0.0.1:5000").split(","),
  tenant,
  token,
  env("CANVAS_FELIX_SERVER_NAME", "localhost"),
  process.env.CANVAS_FELIX_CA_FILE || undefined,
);

// The gateway reads the snapshot under the same names; see gateway/src/room.rs.
function roomLog(room: string): RoomLog {
  const ops = `canvas.ops.${room}`;
  const snapshots = `canvas.snap.${room}`;
  return {
    poll: (max, waitMs) => client.groupPoll(tenant, namespace, ops, 0, group, max, waitMs),
    ack: (offset) => client.groupAck(tenant, namespace, ops, 0, group, offset),
    readSnapshot: () => client.cacheGet(tenant, namespace, snapshots, snapshotKey),
    writeSnapshot: (bytes) =>
      client.cachePut(tenant, namespace, snapshots, snapshotKey, Buffer.from(bytes)),
  };
}
const schedule = {
  everyOps: Number(env("CANVAS_SNAPSHOT_EVERY_OPS", "500")),
  everyMs: Number(env("CANVAS_SNAPSHOT_EVERY_MS", "30000")),
};
const snapshotters = new Map(rooms.map((room) => [room, new Snapshotter(roomLog(room), schedule)]));

createServer((_request, response) => {
  const positions = [...snapshotters].map(([room, snapshotter]) => [room, snapshotter.position]);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(Object.fromEntries(positions)));
}).listen(Number(port), host, () =>
  console.log(`snapshotter for ${rooms.join(", ")} serving its position on ${host}:${port}`),
);

await Promise.all([...snapshotters.values()].map((snapshotter) => snapshotter.start()));
// Records a previous run claimed and never acknowledged stay claimed until
// the group's visibility timeout lapses, and newer records would be handed out
// ahead of them. Waiting it out first means they come back before anything
// newer, so the fold stays in offset order.
await new Promise((resolve) =>
  setTimeout(resolve, Number(env("CANVAS_SNAPSHOTTER_CLAIM_WAIT_MS", "30000"))),
);

async function run(room: string, snapshotter: Snapshotter): Promise<never> {
  for (;;) {
    try {
      await snapshotter.step(1000);
    } catch (err) {
      // Whatever was not acknowledged is handed out again, so waiting and
      // carrying on loses nothing.
      console.error(`snapshotter ${room}: ${String(err)}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

await Promise.all([...snapshotters].map(([room, snapshotter]) => run(room, snapshotter)));
