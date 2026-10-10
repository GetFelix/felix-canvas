import type { IncomingMessage, ServerResponse } from "node:http";

import { SignInError, type Identity } from "./idtoken.js";
import { RoomsError, type Rooms } from "./service.js";

/** Bodies past this are refused; the largest request is a room name. */
const MAX_BODY = 16 * 1024;

const STATUS: Record<string, number> = {
  invalid: 400,
  signed_out: 401,
  forbidden: 403,
  not_found: 404,
  limit: 409,
  invite_invalid: 410,
  invite_expired: 410,
};

type Handler = (who: Identity, params: string[], body: unknown) => unknown;

/**
 * The rooms API under `/api/`, for the page on the same origin. Every route
 * but the health check needs `Authorization: Bearer <ID token>`.
 */
export function roomsApi(
  rooms: Rooms,
  verify: (token: string) => Promise<Identity>,
): (request: IncomingMessage, response: ServerResponse) => void {
  const routes: [string, RegExp, Handler][] = [
    [
      "GET",
      /^\/api\/rooms$/,
      (who) => ({
        rooms: rooms.list(who),
        owned: rooms.owned(who),
        limit: rooms.limits.roomsPerUser,
      }),
    ],
    ["POST", /^\/api\/rooms$/, (who, _, body) => rooms.create(who, field(body, "title"))],
    ["GET", /^\/api\/rooms\/([a-z0-9_-]+)$/, (who, [room]) => rooms.get(who, room!)],
    ["DELETE", /^\/api\/rooms\/([a-z0-9_-]+)$/, (who, [room]) => rooms.delete(who, room!)],
    ["POST", /^\/api\/rooms\/([a-z0-9_-]+)\/invites$/, (who, [room]) => rooms.invite(who, room!)],
    [
      "DELETE",
      /^\/api\/rooms\/([a-z0-9_-]+)\/invites\/([\w-]+)$/,
      (who, [room, invite]) => rooms.revokeInvite(who, room!, invite!),
    ],
    [
      "DELETE",
      /^\/api\/rooms\/([a-z0-9_-]+)\/members\/([\w-]+)$/,
      (who, [room, member]) => rooms.removeMember(who, room!, member!),
    ],
    ["GET", /^\/api\/invites\/([\w.-]+)$/, (who, [token]) => rooms.preview(who, token!)],
    ["POST", /^\/api\/invites\/([\w.-]+)$/, (who, [token]) => rooms.accept(who, token!)],
  ];

  return (request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(body === undefined ? "" : JSON.stringify(body));
    };
    const fail = (code: string, message: string) =>
      reply(STATUS[code] ?? 500, { error: code, message });

    void (async () => {
      const path = new URL(request.url ?? "/", "http://rooms").pathname;
      if (path === "/api/health") return reply(200, { ok: true });
      const matches = routes.filter(([, pattern]) => pattern.test(path));
      const route = matches.find(([method]) => method === request.method);
      if (!route) {
        return matches.length > 0
          ? reply(405, { error: "method", message: "Not allowed here." })
          : reply(404, { error: "not_found", message: "No such thing." });
      }
      const header = request.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      let who: Identity;
      try {
        who = await verify(token);
      } catch (err) {
        if (!(err instanceof SignInError)) throw err;
        return fail("signed_out", "Sign in again to continue.");
      }
      const body = request.method === "POST" ? await readJson(request) : undefined;
      const params = route[1].exec(path)!.slice(1).map(decodeURIComponent);
      const result = await route[2](who, params, body);
      reply(request.method === "POST" ? 201 : 200, result ?? {});
    })().catch((err: unknown) => {
      if (err instanceof RoomsError) return fail(err.code, err.message);
      if (err instanceof BodyError) return fail("invalid", err.message);
      console.error(`rooms: ${request.method} ${request.url}: ${String(err)}`);
      if (!response.headersSent) reply(502, { error: "unavailable", message: "Try again soon." });
    });
  };
}

class BodyError extends Error {}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BodyError("That request is too large.");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BodyError("That request isn't JSON.");
  }
}

function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[name]
    : undefined;
}
