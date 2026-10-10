// The rooms service's side of Felix: its own tokens, the control plane calls
// that create and remove a room, and the registry cache.
import felix, { type Client } from "felix-client";

import type { Provisioner, Registry } from "./service.js";
import { REGISTRY_CACHE, decodeRecord, encodeRecord, type RoomRecord } from "./record.js";

/** A token this close to expiry is replaced before use. */
const RENEW_BEFORE_S = 5 * 60;

export interface FelixSettings {
  controlPlane: string;
  tenant: string;
  namespace: string;
  /** The internal provider the service accounts sign in with (felix#954). */
  serviceIdp: string;
  /** Copies of each room's streams and caches. */
  replicas: number;
}

/**
 * Felix tokens for the `canvas-admin` service account, which the seed made a
 * tenant admin. Felix issues tokens only in exchange for an ID token, so this
 * signs in with the internal provider first, as the seed does.
 */
export class ServiceTokens {
  readonly #settings: FelixSettings;
  readonly #cached = new Map<string, string>();

  constructor(settings: FelixSettings) {
    this.#settings = settings;
  }

  /** A token for the control plane's API. */
  controlPlane(): Promise<string> {
    return this.#token("cp", { audience: "felix-controlplane" });
  }

  /** A token for the brokers, for the registry cache. */
  brokers(): Promise<string> {
    return this.#token("data", { requested: ["cache.read", "cache.write"] });
  }

  async #token(kind: string, body: object): Promise<string> {
    const cached = this.#cached.get(kind);
    if (cached && !expiring(cached)) return cached;
    const { serviceIdp, controlPlane, tenant } = this.#settings;
    const minted = await call("GET", `${serviceIdp}/token?sub=canvas-admin&aud=felix-canvas`);
    const exchange = `${controlPlane}/v1/tenants/${tenant}/token/exchange`;
    const answer = await call("POST", exchange, { token: minted.id_token as string, body });
    const token = answer.felix_token as string;
    this.#cached.set(kind, token);
    return token;
  }
}

/** Whether a JWT expires within {@link RENEW_BEFORE_S}. */
export function expiring(token: string, nowS = Date.now() / 1000): boolean {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    return typeof claims.exp !== "number" || claims.exp - RENEW_BEFORE_S < nowS;
  } catch {
    return true;
  }
}

/**
 * The policies of a room's role: exactly what a session in the room needs,
 * which is what the gateway's narrowing asks for. dev/seed.mjs grants the
 * same to operator rooms; keep the two in step.
 */
export function roomPolicies(
  tenant: string,
  namespace: string,
  room: string,
): { subject: string; object: string; action: string }[] {
  const role = roomRole(room);
  const object = (kind: string, name: string) => `${kind}:${tenant}/${namespace}/${name}`;
  return [
    ...[`canvas.ops.${room}`, `canvas.presence.${room}`].flatMap((stream) => [
      { subject: role, object: object("stream", stream), action: "stream.publish" },
      { subject: role, object: object("stream", stream), action: "stream.subscribe" },
    ]),
    // Counters authorize as cache writes.
    { subject: role, object: object("cache", `canvas.seq.${room}`), action: "cache.write" },
    { subject: role, object: object("cache", `canvas.snap.${room}`), action: "cache.read" },
    { subject: role, object: object("cache", `canvas.members.${room}`), action: "cache.read" },
    { subject: role, object: object("cache", `canvas.members.${room}`), action: "cache.write" },
  ];
}

export const roomRole = (room: string) => `role:room-${room}`;

const RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** Creates and removes rooms through the control plane, as the seed does for operator rooms. */
export class ControlPlaneProvisioner implements Provisioner {
  readonly #settings: FelixSettings;
  readonly #tokens: ServiceTokens;

  constructor(settings: FelixSettings, tokens: ServiceTokens) {
    this.#settings = settings;
    this.#tokens = tokens;
  }

  async create(room: string, owner: string): Promise<void> {
    const { replicas } = this.#settings;
    // Felix only promotes a replica it knows holds every acknowledged record
    // when the ack waited for a majority.
    const consistency = replicas > 1 ? "Quorum" : "Leader";
    for (const [stream, durable] of [
      [`canvas.ops.${room}`, true],
      [`canvas.presence.${room}`, false],
    ] as const) {
      await this.#api("POST", this.#ns("streams"), {
        stream,
        kind: "Stream",
        shards: 1,
        replication_factor: replicas,
        retention: { max_age_seconds: durable ? RETENTION_SECONDS : null, max_size_bytes: null },
        consistency: durable ? consistency : "Leader",
        delivery: durable ? "AtLeastOnce" : "AtMostOnce",
        durable,
      });
    }
    for (const [cache, display_name] of [
      [`canvas.seq.${room}`, `Op sequence per session in ${room}`],
      [`canvas.snap.${room}`, `Snapshot of ${room}`],
      [`canvas.members.${room}`, `Members of ${room}`],
    ]) {
      await this.#api("POST", this.#ns("caches"), {
        cache,
        display_name,
        shards: 1,
        replication_factor: replicas,
        consistency,
      });
    }
    for (const policy of this.#policies(room)) {
      await this.#api("POST", this.#rbac("policies"), policy);
    }
    await this.grant(room, owner);
  }

  async destroy(room: string, members: string[]): Promise<void> {
    for (const member of members) await this.revoke(room, member);
    for (const policy of this.#policies(room)) {
      await this.#api("DELETE", this.#rbac("policies"), policy);
    }
    for (const stream of [`canvas.ops.${room}`, `canvas.presence.${room}`]) {
      await this.#api("DELETE", `${this.#ns("streams")}/${stream}`);
    }
    for (const cache of [`canvas.seq.${room}`, `canvas.snap.${room}`, `canvas.members.${room}`]) {
      await this.#api("DELETE", `${this.#ns("caches")}/${cache}`);
    }
  }

  async grant(room: string, principal: string): Promise<void> {
    await this.#api("POST", this.#rbac("groupings"), { user: principal, role: roomRole(room) });
  }

  async revoke(room: string, principal: string): Promise<void> {
    await this.#api("DELETE", this.#rbac("groupings"), { user: principal, role: roomRole(room) });
  }

  #policies(room: string) {
    return roomPolicies(this.#settings.tenant, this.#settings.namespace, room);
  }

  #ns(kind: string): string {
    const { controlPlane, tenant, namespace } = this.#settings;
    return `${controlPlane}/v1/tenants/${tenant}/namespaces/${namespace}/${kind}`;
  }

  #rbac(kind: string): string {
    return `${this.#settings.controlPlane}/v1/tenants/${this.#settings.tenant}/rbac/${kind}`;
  }

  // Creating what exists and removing what is gone both count as done, so a
  // retry after a partial failure finishes the job.
  async #api(method: string, url: string, body?: object): Promise<void> {
    const token = await this.#tokens.controlPlane();
    await call(method, url, { token, ...(body ? { body } : {}), tolerate: [404, 409] });
  }
}

async function call(
  method: string,
  url: string,
  { token, body, tolerate = [] }: { token?: string; body?: object; tolerate?: number[] } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (tolerate.includes(response.status)) return {};
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}: ${text}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export interface BrokerSettings {
  brokers: string[];
  serverName: string;
  caFile: string | undefined;
}

/**
 * The registry cache through a Felix client of the service's own. The client
 * is replaced when its token nears expiry or its connection drops.
 */
export class FelixRegistry implements Registry {
  readonly #settings: FelixSettings & BrokerSettings;
  readonly #tokens: ServiceTokens;
  #client: { client: Client; token: string } | null = null;

  constructor(settings: FelixSettings & BrokerSettings, tokens: ServiceTokens) {
    this.#settings = settings;
    this.#tokens = tokens;
  }

  /** Every record in the registry, read through a watch that delivers each key's value. */
  async load(): Promise<RoomRecord[]> {
    return this.#with(async (client) => {
      const { tenant, namespace } = this.#settings;
      const watch = await client.watchCache(
        tenant,
        namespace,
        REGISTRY_CACHE,
        undefined,
        "",
        undefined,
        true,
      );
      const records = new Map<string, RoomRecord>();
      try {
        for (let left = watch.retainedCount ?? 0n; left > 0n; left--) {
          const item = await watch.recv();
          if (!item) throw new Error("the registry watch ended while loading");
          const change = item.change;
          if (!change) continue;
          const record = change.value ? decodeRecord(change.value) : null;
          if (record) records.set(change.key, record);
          else records.delete(change.key);
        }
      } finally {
        await watch.close();
      }
      return [...records.values()];
    });
  }

  put(record: RoomRecord): Promise<void> {
    const { tenant, namespace } = this.#settings;
    const bytes = Buffer.from(encodeRecord(record));
    return this.#with((client) =>
      client.cachePut(tenant, namespace, REGISTRY_CACHE, record.id, bytes),
    );
  }

  async delete(room: string): Promise<void> {
    const { tenant, namespace } = this.#settings;
    await this.#with((client) => client.cacheDelete(tenant, namespace, REGISTRY_CACHE, room));
  }

  async #with<T>(use: (client: Client) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.#connected();
      try {
        return await use(client);
      } catch (err) {
        if (attempt > 0 || !(err instanceof felix.ConnectionError)) throw err;
        this.#drop(client);
        // The next address, in case that broker is the one that went away.
        this.#settings.brokers.push(this.#settings.brokers.shift()!);
      }
    }
  }

  async #connected(): Promise<Client> {
    if (this.#client && !expiring(this.#client.token)) return this.#client.client;
    if (this.#client) this.#drop(this.#client.client);
    const token = await this.#tokens.brokers();
    const { brokers, tenant, serverName, caFile } = this.#settings;
    const client = await felix.Client.connect(brokers, tenant, token, serverName, caFile);
    this.#client = { client, token };
    return client;
  }

  #drop(client: Client): void {
    if (this.#client?.client === client) this.#client = null;
    try {
      client.close();
    } catch {}
  }
}
