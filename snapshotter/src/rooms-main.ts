// The rooms service: signed-in people create rooms, invite others and manage
// their own rooms. It holds the Felix admin credential the page must never
// have. Settings are CANVAS_* variables; see docs/self-hosting.md.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { ControlPlaneProvisioner, FelixRegistry, ServiceTokens } from "./rooms/felix.js";
import { roomsApi } from "./rooms/http.js";
import { IdTokenVerifier, fetchKeys } from "./rooms/idtoken.js";
import { DEFAULT_LIMITS, Rooms } from "./rooms/service.js";

const env = (name: string, fallback: string): string => process.env[name] || fallback;
const number = (name: string, fallback: number): number => {
  const value = Number(env(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`${name} must be a number above 0`);
    process.exit(1);
  }
  return value;
};

const secretFile = env("CANVAS_INVITE_SECRET_FILE", "");
const secret = secretFile
  ? readFileSync(secretFile, "utf8").trim()
  : env("CANVAS_INVITE_SECRET", "");
if (secret.length < 16) {
  console.error(
    "Set CANVAS_INVITE_SECRET or CANVAS_INVITE_SECRET_FILE to at least 16 random characters",
  );
  process.exit(1);
}

const serviceIdp = env("CANVAS_SERVICE_IDP", "http://idp:9400").replace(/\/$/, "");
const settings = {
  controlPlane: env("CANVAS_FELIX_CONTROL_PLANE", "http://controlplane:8443").replace(/\/$/, ""),
  tenant: env("CANVAS_TENANT", "canvas"),
  namespace: env("CANVAS_NAMESPACE", "default"),
  serviceIdp,
  replicas: number("CANVAS_REPLICAS", 1),
  brokers: env("CANVAS_FELIX_BROKERS", "127.0.0.1:5000").split(","),
  serverName: env("CANVAS_FELIX_SERVER_NAME", "localhost"),
  caFile: process.env.CANVAS_FELIX_CA_FILE || undefined,
};

async function discover(base: string): Promise<{ issuer: string; jwks_uri: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${base.replace(/\/$/, "")}/.well-known/openid-configuration`);
      if (response.ok) return (await response.json()) as { issuer: string; jwks_uri: string };
      throw new Error(`${response.status}`);
    } catch (err) {
      if (attempt === 30) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

// The browsers' provider, found the same way the seed finds it.
const service = await discover(serviceIdp);
const issuer = env("CANVAS_OIDC_ISSUER", service.issuer);
const jwksUrl =
  process.env.CANVAS_OIDC_JWKS_URL ||
  (issuer === service.issuer ? `${serviceIdp}/jwks.json` : (await discover(issuer)).jwks_uri);
const verifier = new IdTokenVerifier({
  issuer,
  audience: env("CANVAS_OIDC_AUDIENCE", env("CANVAS_OIDC_CLIENT_ID", "felix-canvas")),
  subjectClaim: env("CANVAS_OIDC_SUBJECT_CLAIM", "sub"),
  keys: () => fetchKeys(jwksUrl),
});

const tokens = new ServiceTokens(settings);
const registry = new FelixRegistry(settings, tokens);
const rooms = new Rooms({
  provisioner: new ControlPlaneProvisioner(settings, tokens),
  registry,
  records: await registry.load(),
  secret,
  limits: {
    roomsPerUser: number("CANVAS_ROOMS_PER_USER", DEFAULT_LIMITS.roomsPerUser),
    membersPerRoom: number("CANVAS_MEMBERS_PER_ROOM", DEFAULT_LIMITS.membersPerRoom),
    invitesPerRoom: number("CANVAS_INVITES_PER_ROOM", DEFAULT_LIMITS.invitesPerRoom),
    inviteTtlMs:
      number("CANVAS_INVITE_TTL_HOURS", DEFAULT_LIMITS.inviteTtlMs / 3_600_000) * 3_600_000,
  },
});

const [host, port] = env("CANVAS_ROOMS_LISTEN", "127.0.0.1:8789").split(":");
createServer(roomsApi(rooms, (token) => verifier.verify(token))).listen(Number(port), host, () =>
  console.log(`rooms service for ${issuer} on ${host}:${port}`),
);
