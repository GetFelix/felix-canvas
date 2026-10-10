import { createHmac, timingSafeEqual } from "node:crypto";

/** What an invite link carries. */
export interface InviteClaims {
  room: string;
  /** The invite's id, which the room's record must still hold for it to work. */
  id: string;
  /** Unix milliseconds. */
  expires: number;
}

/**
 * The token in an invite link: the claims and an HMAC-SHA256 over them, both
 * base64url. Signing stops anyone from making up a link; revocation is the
 * room record dropping the id, which every accept checks.
 */
export function signInvite(secret: string, claims: InviteClaims): string {
  const body = Buffer.from(JSON.stringify([claims.room, claims.id, claims.expires])).toString(
    "base64url",
  );
  return `${body}.${mac(secret, body)}`;
}

/** The claims of a token {@link signInvite} made with `secret`, or `null`. Expiry is not checked. */
export function readInvite(secret: string, token: string): InviteClaims | null {
  const [body, signature, ...rest] = token.split(".");
  if (!body || !signature || rest.length > 0) return null;
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(signature);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [room, id, expires] = value as unknown[];
    if (typeof room !== "string" || typeof id !== "string" || typeof expires !== "number") {
      return null;
    }
    return { room, id, expires };
  } catch {
    return null;
  }
}

function mac(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}
