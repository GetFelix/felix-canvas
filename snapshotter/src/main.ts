// Keeps a snapshot of every room in CANVAS_ROOMS and every room the rooms
// service created, with one Snapshotter per room. Settings come from the same
// CANVAS_* variables as the gateway, plus its own token; see
// docs/self-hosting.md.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import felix from "felix-client";

import { REGISTRY_CACHE } from "./rooms/record.js";
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

const brokers = env("CANVAS_FELIX_BROKERS", "127.0.0.1:5000").split(",");
const connect = () =>
  felix.Client.connect(
    brokers,
    tenant,
    token,
    env("CANVAS_FELIX_SERVER_NAME", "localhost"),
    process.env.CANVAS_FELIX_CA_FILE || undefined,
  );
let client = await connect();

// The gateway reads the snapshot under the same names; see deploy/scope.toml.
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
const claimMs = Number(env("CANVAS_SNAPSHOTTER_CLAIM_WAIT_MS", "30000"));
const schedule = {
  everyOps: Number(env("CANVAS_SNAPSHOT_EVERY_OPS", "500")),
  everyMs: Number(env("CANVAS_SNAPSHOT_EVERY_MS", "30000")),
  claimMs,
};
const snapshotters = new Map<string, Snapshotter>();
const configured = new Set(rooms);
for (const room of rooms) snapshotters.set(room, new Snapshotter(roomLog(room), schedule));

createServer((_request, response) => {
  const positions = [...snapshotters].map(([room, snapshotter]) => [room, snapshotter.position]);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(Object.fromEntries(positions)));
}).listen(Number(port), host, () =>
  console.log(`snapshotter for ${rooms.join(", ")} serving its position on ${host}:${port}`),
);

const waitOutClaims = () => new Promise((resolve) => setTimeout(resolve, claimMs));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let reconnecting: Promise<void> | null = null;

// The client keeps dialling a broker it lost rather than moving on, so
// connect again from the next address. A poll answer lost with the
// connection left records claimed, so wait those out as at startup. Every
// room shares the client, so the first room to notice reconnects for all.
function reconnect(lost: typeof client): Promise<void> {
  if (client !== lost) return reconnecting ?? Promise.resolve();
  reconnecting ??= (async () => {
    brokers.push(brokers.shift()!);
    try {
      client = await connect();
      await waitOutClaims();
    } catch (retry) {
      console.error(`snapshotter: ${String(retry)}`);
    } finally {
      reconnecting = null;
    }
  })();
  return reconnecting;
}

/** Set once the first rooms are folding; rooms found after that start at once. */
let started = false;

function addRoom(room: string): void {
  if (snapshotters.has(room)) return;
  const snapshotter = new Snapshotter(roomLog(room), schedule);
  snapshotters.set(room, snapshotter);
  console.log(`snapshotter: folding ${room}`);
  // A new room has nothing an earlier run claimed, so there is nothing to wait out.
  if (started) void begin(room, snapshotter);
}

function removeRoom(room: string): void {
  if (configured.has(room) || !snapshotters.delete(room)) return;
  console.log(`snapshotter: ${room} was deleted`);
}

async function begin(room: string, snapshotter: Snapshotter): Promise<void> {
  while (snapshotters.get(room) === snapshotter) {
    try {
      await snapshotter.start();
      return run(room, snapshotter);
    } catch (err) {
      console.error(`snapshotter ${room}: ${String(err)}`);
      await sleep(1000);
    }
  }
}

/**
 * Follow the rooms service's registry: a watch that first delivers every
 * room it lists, then each room created or deleted. Resolves `listed` once
 * the first full list is in, or once it is clear there is none to read.
 */
async function followRegistry(listed: () => void): Promise<never> {
  for (;;) {
    const used = client;
    try {
      const watch = await client.watchCache(
        tenant,
        namespace,
        REGISTRY_CACHE,
        undefined,
        "",
        undefined,
        true,
      );
      // Every retained value comes first, so the rooms missing from them were
      // deleted while no watch was open.
      let left = watch.retainedCount ?? 0n;
      const seen = new Set<string>();
      const reconcile = () => {
        for (const room of [...snapshotters.keys()]) if (!seen.has(room)) removeRoom(room);
        listed();
      };
      if (left === 0n) reconcile();
      for (;;) {
        const item = await watch.recv();
        // The addon hands back a missing field as undefined, not the null its types say.
        if (!item || item.laggedResumeFrom != null) break;
        const change = item.change;
        if (!change) continue;
        if (change.value) {
          seen.add(change.key);
          addRoom(change.key);
        } else {
          seen.delete(change.key);
          removeRoom(change.key);
        }
        if (left > 0n && --left === 0n) reconcile();
      }
      await watch.close().catch(() => {});
    } catch (err) {
      // A deployment from before self-service rooms has no registry; its
      // configured rooms carry on regardless.
      console.error(`snapshotter: room list: ${String(err)}`);
      listed();
      if (err instanceof felix.ConnectionError) await reconnect(used);
      else await sleep(30_000);
    }
    await sleep(2000);
  }
}

await new Promise<void>((resolve) => void followRegistry(resolve));
// Records a previous run claimed and never acknowledged stay claimed until
// the group's visibility timeout lapses, and newer records would be handed out
// ahead of them. Waiting it out first means they come back before anything
// newer, so the fold stays in offset order.
await waitOutClaims();

async function run(room: string, snapshotter: Snapshotter): Promise<void> {
  while (snapshotters.get(room) === snapshotter) {
    const used = client;
    try {
      await snapshotter.step(1000);
    } catch (err) {
      // Whatever was not acknowledged is handed out again, so waiting and
      // carrying on loses nothing.
      console.error(`snapshotter ${room}: ${String(err)}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (err instanceof felix.ConnectionError) await reconnect(used);
    }
  }
}

started = true;
for (const [room, snapshotter] of snapshotters) void begin(room, snapshotter);
