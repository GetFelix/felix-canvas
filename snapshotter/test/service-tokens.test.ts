import { afterEach, describe, expect, it, vi } from "vitest";

import { ServiceTokens } from "../src/rooms/felix.js";

const settings = {
  controlPlane: "http://cp:8443",
  tenant: "canvas",
  namespace: "default",
  serviceIdp: "http://idp:9400",
  replicas: 1,
};

/** An answerer for the provider and the exchange that counts the tokens it has minted. */
function stubFelix() {
  const calls: { url: string; body: unknown }[] = [];
  let minted = 0;
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const answer = url.startsWith(settings.serviceIdp)
      ? { id_token: "id" }
      : { felix_token: `felix-${++minted}` };
    return new Response(JSON.stringify(answer));
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("ServiceTokens.fresh", () => {
  it("signs in as the given account and asks for what it is given", async () => {
    const calls = stubFelix();
    const tokens = new ServiceTokens(settings, "canvas-snapshotter");
    await tokens.fresh(["stream.subscribe", "cache.read"]);
    expect(calls[0]!.url).toBe("http://idp:9400/token?sub=canvas-snapshotter&aud=felix-canvas");
    expect(calls[1]!.url).toBe("http://cp:8443/v1/tenants/canvas/token/exchange");
    expect(calls[1]!.body).toEqual({ requested: ["stream.subscribe", "cache.read"] });
  });

  it("mints a new token every time", async () => {
    stubFelix();
    const tokens = new ServiceTokens(settings, "canvas-snapshotter");
    expect(await tokens.fresh(["cache.read"])).toBe("felix-1");
    expect(await tokens.fresh(["cache.read"])).toBe("felix-2");
  });

  it("signs in as canvas-admin by default", async () => {
    const calls = stubFelix();
    await new ServiceTokens(settings).fresh(["cache.read"]);
    expect(calls[0]!.url).toContain("sub=canvas-admin");
  });
});
