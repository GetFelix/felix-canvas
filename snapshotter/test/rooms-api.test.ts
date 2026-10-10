import {
  generateKeyPairSync,
  randomUUID,
  sign,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { roomsApi } from "../src/rooms/http.js";
import { IdTokenVerifier, SignInError, principalOf } from "../src/rooms/idtoken.js";
import type { RoomRecord } from "../src/rooms/record.js";
import { Rooms, type Provisioner, type Registry } from "../src/rooms/service.js";

const ISSUER = "https://login.example.com";
const AUDIENCE = "felix-canvas";

interface Signer {
  alg: "ES256" | "RS256";
  kid: string;
  key: KeyObject;
  jwk: JsonWebKey;
}

function signer(alg: "ES256" | "RS256"): Signer {
  const { privateKey, publicKey } =
    alg === "ES256"
      ? generateKeyPairSync("ec", { namedCurve: "P-256" })
      : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomUUID();
  return { alg, kid, key: privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid } };
}

function token(by: Signer, claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = part({ alg: by.alg, typ: "JWT", kid: by.kid });
  const body = part({ iss: ISSUER, aud: AUDIENCE, sub: "ana", exp: now + 600, ...claims });
  const signature = sign(
    "sha256",
    Buffer.from(`${head}.${body}`),
    by.alg === "ES256" ? { key: by.key, dsaEncoding: "ieee-p1363" } : by.key,
  );
  return `${head}.${body}.${signature.toString("base64url")}`;
}

function verifier(keys: () => JsonWebKey[], subjectClaim = "sub") {
  let fetches = 0;
  const instance = new IdTokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    subjectClaim,
    keys: async () => {
      fetches++;
      return keys();
    },
  });
  return { instance, fetches: () => fetches };
}

describe("ID tokens", () => {
  const es = signer("ES256");
  const rs = signer("RS256");

  it("accepts ES256 and RS256 tokens from the provider's keys", async () => {
    const { instance } = verifier(() => [es.jwk, rs.jwk]);
    const who = await instance.verify(token(es, { name: "Ana Lima" }));
    expect(who).toEqual({ principal: principalOf(ISSUER, "ana"), name: "Ana Lima" });
    expect((await instance.verify(token(rs, { sub: "ben" }))).name).toBe("ben");
  });

  it("names people by the configured claim, as Felix does", async () => {
    const { instance } = verifier(() => [es.jwk], "email");
    const who = await instance.verify(token(es, { email: "ana@example.com" }));
    expect(who.principal).toBe(principalOf(ISSUER, "ana@example.com"));
    await expect(instance.verify(token(es, {}))).rejects.toThrow(SignInError);
  });

  it("refuses a wrong issuer, audience, lifetime or signature", async () => {
    const { instance } = verifier(() => [es.jwk]);
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [
      { iss: "https://elsewhere.example.com" },
      { aud: "another-app" },
      { exp: now - 120 },
      { nbf: now + 600 },
      { exp: undefined },
    ]) {
      await expect(instance.verify(token(es, claims))).rejects.toThrow(SignInError);
    }
    const stranger = signer("ES256");
    await expect(instance.verify(token({ ...stranger, kid: es.kid }, {}))).rejects.toThrow(
      SignInError,
    );
    await expect(instance.verify("not.a.token")).rejects.toThrow(SignInError);
    await expect(instance.verify("")).rejects.toThrow(SignInError);
    const [head, body] = token(es, {}).split(".");
    const none = Buffer.from(JSON.stringify({ alg: "none", kid: es.kid })).toString("base64url");
    await expect(instance.verify(`${none}.${body}.`)).rejects.toThrow(SignInError);
    await expect(instance.verify(`${head}.${body}.AAAA`)).rejects.toThrow(SignInError);
  });

  it("accepts an audience list that holds the client", async () => {
    const { instance } = verifier(() => [es.jwk]);
    await instance.verify(token(es, { aud: ["other", AUDIENCE] }));
  });

  it("fetches the keys again for a key it has not seen, at most once a minute", async () => {
    let keys = [es.jwk];
    const { instance, fetches } = verifier(() => keys);
    await instance.verify(token(es, {}));
    const rotated = signer("ES256");
    keys = [es.jwk, rotated.jwk];
    // The first fetch was just now, so the new key is not known yet.
    await expect(instance.verify(token(rotated, {}))).rejects.toThrow(SignInError);
    expect(fetches()).toBe(1);
  });
});

class NullFelix implements Provisioner, Registry {
  async create(): Promise<void> {}
  async destroy(): Promise<void> {}
  async grant(): Promise<void> {}
  async revoke(): Promise<void> {}
  async put(_record: RoomRecord): Promise<void> {}
  async delete(): Promise<void> {}
}

describe("the rooms API", () => {
  let server: Server;
  let base = "";
  const felix = new NullFelix();
  const rooms = new Rooms({
    provisioner: felix,
    registry: felix,
    records: [],
    secret: "a-test-secret-of-some-length",
  });
  // A bearer token is the person's name, so tests can be anyone.
  const people = new Map([
    ["ana", { principal: "p-ana", name: "Ana" }],
    ["ben", { principal: "p-ben", name: "Ben" }],
  ]);

  beforeAll(async () => {
    server = createServer(
      roomsApi(rooms, async (bearer) => {
        const who = people.get(bearer);
        if (!who) throw new SignInError("unknown");
        return who;
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = async (as: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };

  it("answers the health check without a sign-in", async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it("refuses everything else without a valid sign-in", async () => {
    expect((await call("mallory", "GET", "/api/rooms")).status).toBe(401);
    expect((await call("mallory", "POST", "/api/rooms", { title: "x" })).body.error).toBe(
      "signed_out",
    );
  });

  it("creates, invites, joins, removes and deletes", async () => {
    const created = await call("ana", "POST", "/api/rooms", { title: "Team sketch" });
    expect(created.status).toBe(201);
    const room = created.body.id as string;
    expect((await call("ana", "GET", "/api/rooms")).body).toMatchObject({
      rooms: [{ id: room, title: "Team sketch", owner: true }],
      owned: 1,
    });
    expect((await call("ben", "GET", `/api/rooms/${room}`)).status).toBe(404);
    expect((await call("ben", "POST", `/api/rooms/${room}/invites`)).status).toBe(404);

    const invite = (await call("ana", "POST", `/api/rooms/${room}/invites`)).body;
    expect((await call("ben", "GET", `/api/invites/${invite.token}`)).body).toMatchObject({
      room,
      title: "Team sketch",
      ownerName: "Ana",
      member: false,
    });
    expect((await call("ben", "POST", `/api/invites/${invite.token}`)).status).toBe(201);
    expect((await call("ben", "DELETE", `/api/rooms/${room}`)).status).toBe(403);
    expect((await call("ben", "DELETE", `/api/rooms/${room}/members/p-ana`)).status).toBe(400);

    expect((await call("ana", "DELETE", `/api/rooms/${room}/invites/${invite.id}`)).status).toBe(
      200,
    );
    expect((await call("ben", "GET", `/api/invites/${invite.token}`)).status).toBe(410);
    expect((await call("ana", "DELETE", `/api/rooms/${room}/members/p-ben`)).status).toBe(200);
    expect((await call("ben", "GET", `/api/rooms/${room}`)).status).toBe(404);
    expect((await call("ana", "DELETE", `/api/rooms/${room}`)).status).toBe(200);
    expect((await call("ana", "GET", "/api/rooms")).body.rooms).toEqual([]);
  });

  it("explains a bad request in words", async () => {
    const answer = await call("ana", "POST", "/api/rooms", { title: "" });
    expect(answer.status).toBe(400);
    expect(answer.body.message).toMatch(/1 to 60 characters/);
    const response = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { authorization: "Bearer ana" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect((await call("ana", "PUT", "/api/rooms")).status).toBe(405);
    expect((await call("ana", "GET", "/api/nothing")).status).toBe(404);
  });
});
