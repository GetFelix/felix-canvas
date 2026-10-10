import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

/** A public key in JWK form, as `createPublicKey` takes it. */
type JsonWebKey = Extract<Parameters<typeof createPublicKey>[0], { format: "jwk" }>["key"];

/** Who a verified ID token says the caller is. */
export interface Identity {
  /** The Felix principal: hex SHA-256 of `issuer|subject`, as Felix RBAC keys people. */
  principal: string;
  /** The name to show for them. */
  name: string;
}

export interface VerifierOptions {
  /** The issuer browsers sign in with, exactly as tokens carry it. */
  issuer: string;
  /** The audience browsers' ID tokens carry, normally the client ID. */
  audience: string;
  /** The claim that names a person, as the seed and Felix are told. */
  subjectClaim: string;
  /** The provider's signing keys. Called again, at most once a minute, for an unknown key id. */
  keys: () => Promise<JsonWebKey[]>;
  now?: () => number;
}

/** Thrown for any ID token that is not usable. The message says why, for logs. */
export class SignInError extends Error {}

/** Clock skew allowed on `exp`, `nbf` and `iat`. */
const LEEWAY_S = 60;
const REFETCH_MS = 60_000;

/** Felix keys RBAC on this, not on the subject itself. */
export function principalOf(issuer: string, subject: string): string {
  return createHash("sha256").update(`${issuer}|${subject}`).digest("hex");
}

/**
 * Verifies the browsers' ID tokens the way the control plane does for the
 * gateway: an ES256 or RS256 signature by one of the provider's keys, the
 * issuer, the audience and the lifetime.
 */
export class IdTokenVerifier {
  readonly #options: VerifierOptions;
  readonly #now: () => number;
  #keys = new Map<string, { key: KeyObject; alg: string }>();
  #fetchedAt = -Infinity;

  constructor(options: VerifierOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async verify(token: string): Promise<Identity> {
    const [head, body, signature, ...rest] = token.split(".");
    if (!head || !body || !signature || rest.length > 0) throw new SignInError("not a JWT");
    const header = parse(head);
    const claims = parse(body);
    const alg = header.alg;
    if (alg !== "ES256" && alg !== "RS256") throw new SignInError(`algorithm ${String(alg)}`);
    const key = await this.#key(typeof header.kid === "string" ? header.kid : "", alg);
    const valid = verify(
      "sha256",
      Buffer.from(`${head}.${body}`),
      alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key,
      Buffer.from(signature, "base64url"),
    );
    if (!valid) throw new SignInError("bad signature");

    const { issuer, audience, subjectClaim } = this.#options;
    if (claims.iss !== issuer) throw new SignInError(`issuer ${String(claims.iss)}`);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience)) throw new SignInError("audience");
    const now = this.#now() / 1000;
    if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S < now) {
      throw new SignInError("expired");
    }
    if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_S > now) {
      throw new SignInError("not yet valid");
    }
    const subject = claims[subjectClaim];
    if (typeof subject !== "string" || !subject) throw new SignInError(`no ${subjectClaim}`);
    let name = subject;
    for (const claim of ["name", "preferred_username", "email"]) {
      const value = claims[claim];
      if (typeof value === "string" && value.trim()) {
        name = value.trim();
        break;
      }
    }
    return { principal: principalOf(issuer, subject), name: name.slice(0, 64) };
  }

  async #key(kid: string, alg: string): Promise<KeyObject> {
    let found = this.#find(kid, alg);
    if (!found && this.#now() - this.#fetchedAt >= REFETCH_MS) {
      await this.#refresh();
      found = this.#find(kid, alg);
    }
    if (!found) throw new SignInError(`no key ${kid}`);
    return found;
  }

  #find(kid: string, alg: string): KeyObject | null {
    if (kid) {
      const entry = this.#keys.get(kid);
      return entry && entry.alg === alg ? entry.key : null;
    }
    // A provider with a single key may leave the key id out.
    const matching = [...this.#keys.values()].filter((entry) => entry.alg === alg);
    return matching.length === 1 ? matching[0]!.key : null;
  }

  async #refresh(): Promise<void> {
    this.#fetchedAt = this.#now();
    let fetched: JsonWebKey[];
    try {
      fetched = await this.#options.keys();
    } catch (err) {
      // Try again a few seconds on, not a minute: sign-ins wait on it.
      this.#fetchedAt = this.#now() - REFETCH_MS + 5_000;
      throw err;
    }
    const keys = new Map<string, { key: KeyObject; alg: string }>();
    for (const [i, jwk] of fetched.entries()) {
      const alg =
        jwk.kty === "EC" && jwk.crv === "P-256" ? "ES256" : jwk.kty === "RSA" ? "RS256" : null;
      if (!alg || (jwk.use !== undefined && jwk.use !== "sig")) continue;
      try {
        const key = createPublicKey({ key: jwk, format: "jwk" });
        keys.set(typeof jwk.kid === "string" ? jwk.kid : `#${i}`, { key, alg });
      } catch {
        // A key this runtime cannot load cannot have signed anything we accept.
      }
    }
    this.#keys = keys;
  }
}

/** Fetch a JWKS document's keys. */
export async function fetchKeys(url: string): Promise<JsonWebKey[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  const body = (await response.json()) as { keys?: JsonWebKey[] };
  return body.keys ?? [];
}

function parse(part: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {}
  throw new SignInError("unreadable JWT");
}
