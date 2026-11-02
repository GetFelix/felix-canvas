import { afterEach, describe, expect, it, vi } from "vitest";

import { CALL_TIMEOUT_MS, ServiceTokens } from "../src/rooms/felix.js";
import { credentialOptions } from "../src/token-options.js";

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A fetch that never answers and rejects when its signal aborts, as the real one does. */
function stubStalledFetch() {
  const stalled = (_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  vi.stubGlobal("fetch", stalled);
}

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

describe("ServiceTokens.fresh when the provider stalls", () => {
  it("is abandoned when the caller aborts", async () => {
    stubStalledFetch();
    const abort = new AbortController();
    const tokens = new ServiceTokens(settings, "canvas-snapshotter");
    const pending = tokens.fresh(["cache.read"], abort.signal);
    const outcome = expect(pending).rejects.toThrow("stop");
    abort.abort(new Error("stop"));
    await outcome;
  });

  it("gives up after the call timeout without a signal", async () => {
    // Node's own timer drives AbortSignal.timeout, so fake timers cannot move
    // it: hand back a signal that has already timed out instead.
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(AbortSignal.abort(new Error("timed out")));
    stubStalledFetch();
    const tokens = new ServiceTokens(settings, "canvas-snapshotter");
    await expect(tokens.fresh(["cache.read"])).rejects.toThrow("timed out");
    expect(timeout).toHaveBeenCalledWith(CALL_TIMEOUT_MS);
  });

  it("hands the caller's signal to the request", async () => {
    let seen: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: { signal?: AbortSignal }) => {
      seen = init?.signal;
      const answer = url.startsWith(settings.serviceIdp)
        ? { id_token: "id" }
        : { felix_token: "felix-1" };
      return new Response(JSON.stringify(answer));
    });
    const abort = new AbortController();
    await new ServiceTokens(settings, "canvas-snapshotter").fresh(["cache.read"], abort.signal);
    expect(seen?.aborted).toBe(false);
    abort.abort();
    expect(seen?.aborted).toBe(true);
  });
});

describe("credentialOptions", () => {
  it("uses the provider when there is one", () => {
    const provider = async () => "t";
    expect(credentialOptions("fixed", provider)).toEqual({ tokenProvider: provider });
  });

  it("uses the fixed token otherwise", () => {
    expect(credentialOptions("fixed", null)).toEqual({ token: "fixed" });
  });
});
