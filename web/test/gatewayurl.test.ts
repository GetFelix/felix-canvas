import { describe, expect, it } from "vitest";
import { gatewayUrl } from "../src/gatewayurl.js";

const page = (search: string, protocol = "https:") => ({
  protocol,
  host: "canvas.example",
  search,
});

describe("gatewayUrl", () => {
  it("ignores ?gateway= in a production build", () => {
    expect(gatewayUrl(page("?gateway=wss://evil.test/ws"), false)).toBe("wss://canvas.example/ws");
  });
  it("honors ?gateway= in a dev build", () => {
    expect(gatewayUrl(page("?gateway=ws://localhost:9/ws"), true)).toBe("ws://localhost:9/ws");
  });
  it("defaults to the page's own origin", () => {
    expect(gatewayUrl(page("", "http:"), true)).toBe("ws://canvas.example/ws");
  });
});
