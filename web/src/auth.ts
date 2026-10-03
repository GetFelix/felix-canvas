// Signing in with the deployment's OpenID Connect provider: the authorization
// code flow with PKCE, as a public client. The ID token it ends with is what
// the page hands the gateway when it joins a room.

/** How the gateway says to sign in, from `GET /oidc`. */
export interface OidcConfig {
  issuer: string;
  client_id: string;
  scopes: string;
}

const TOKEN_KEY = "felix-canvas.id-token";
const PENDING_KEY = "felix-canvas.sign-in";
/** A token this close to expiry is treated as expired, so a join never races it. */
const EXPIRY_MARGIN_S = 60;

interface Pending {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
}

/** The claims of a JWT, unverified. The gateway and Felix do the checking. */
export function claims(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether `token` is still usable at `nowS`, in Unix seconds. */
export function fresh(token: string, nowS = Date.now() / 1000): boolean {
  const exp = claims(token)?.exp;
  return typeof exp === "number" && exp - EXPIRY_MARGIN_S > nowS;
}

/** The name to show for the signed-in person. */
export function displayName(token: string): string {
  const all = claims(token) ?? {};
  for (const claim of ["name", "preferred_username", "email", "sub"]) {
    if (typeof all[claim] === "string" && all[claim]) return all[claim];
  }
  return "";
}

/** The PKCE S256 challenge for `verifier` (RFC 7636). */
export async function challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * The ID token to join with: the one stored from an earlier sign-in, or the
 * one this page load returned from the provider with. `null` means the page
 * must call {@link signIn}.
 *
 * @throws When the provider sent the browser back with an error.
 */
export async function signedIn(config: OidcConfig): Promise<string | null> {
  const params = new URLSearchParams(location.search);
  const pending = read<Pending>(sessionStorage, PENDING_KEY);
  if (params.has("state") && pending?.state === params.get("state")) {
    sessionStorage.removeItem(PENDING_KEY);
    history.replaceState(null, "", pending.returnTo);
    const error = params.get("error");
    if (error) throw new Error(params.get("error_description") ?? error);
    const token = await redeem(config, params.get("code") ?? "", pending);
    write(localStorage, TOKEN_KEY, token);
    return token;
  }
  const stored = read<string>(localStorage, TOKEN_KEY);
  return stored && fresh(stored) ? stored : null;
}

/** Leave for the provider's sign-in page. It comes back to the current address. */
export async function signIn(config: OidcConfig): Promise<never> {
  const { authorization_endpoint } = await discover(config);
  const pending: Pending = {
    state: random(),
    verifier: random(),
    nonce: random(),
    returnTo: location.href,
  };
  write(sessionStorage, PENDING_KEY, pending);
  const url = new URL(authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.client_id,
    redirect_uri: redirectUri(),
    scope: config.scopes,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await challenge(pending.verifier),
    code_challenge_method: "S256",
  }).toString();
  location.assign(url);
  return new Promise(() => {});
}

/** Forget the stored sign-in, so the next load signs in again. */
export function signOut(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

async function redeem(config: OidcConfig, code: string, pending: Pending): Promise<string> {
  const { token_endpoint } = await discover(config);
  const response = await fetch(token_endpoint, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: config.client_id,
      code_verifier: pending.verifier,
    }),
  });
  if (!response.ok) throw new Error(`sign-in was not completed (${response.status})`);
  const { id_token } = (await response.json()) as { id_token?: string };
  // The nonce ties the token to this sign-in, so one lifted from elsewhere is refused.
  if (!id_token || claims(id_token)?.nonce !== pending.nonce) {
    throw new Error("sign-in returned an unexpected answer");
  }
  return id_token;
}

async function discover(
  config: OidcConfig,
): Promise<{ authorization_endpoint: string; token_endpoint: string }> {
  const url = `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cannot reach the sign-in service (${response.status})`);
  return response.json();
}

// One fixed address, because providers match redirect URIs exactly. The room
// and anything else in the address travel in the pending sign-in instead.
function redirectUri(): string {
  return `${location.origin}/`;
}

function random(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function read<T>(storage: Storage, key: string): T | null {
  try {
    const text = storage.getItem(key);
    return text === null ? null : (JSON.parse(text) as T);
  } catch {
    return null;
  }
}

function write(storage: Storage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {}
}
