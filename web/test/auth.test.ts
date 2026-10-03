import { describe, expect, it } from "vitest";

import { challenge, claims, displayName, fresh } from "../src/auth.js";

const jwt = (payload: object) => `e30.${btoa(JSON.stringify(payload)).replace(/=+$/, "")}.c2ln`;

describe("sign-in", () => {
  it("computes the PKCE challenge from RFC 7636", async () => {
    expect(await challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("reads claims, and treats unreadable tokens as none", () => {
    expect(claims(jwt({ sub: "ana", name: "Ana Lima" }))).toEqual({
      sub: "ana",
      name: "Ana Lima",
    });
    expect(claims("garbage")).toBeNull();
  });

  it("treats a token close to expiry as expired", () => {
    const now = 1_000_000;
    expect(fresh(jwt({ exp: now + 3600 }), now)).toBe(true);
    expect(fresh(jwt({ exp: now + 30 }), now)).toBe(false);
    expect(fresh(jwt({}), now)).toBe(false);
  });

  it("names the person by the friendliest claim present", () => {
    expect(displayName(jwt({ sub: "u1", email: "ana@example.com" }))).toBe("ana@example.com");
    expect(displayName(jwt({ sub: "u1", name: "Ana" }))).toBe("Ana");
    expect(displayName(jwt({ sub: "u1" }))).toBe("u1");
  });
});
