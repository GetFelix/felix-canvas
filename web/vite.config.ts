import { defineConfig } from "vite";

// The dev server proxies the gateway's routes, so the page reaches it on its
// own origin in development exactly as it would behind a reverse proxy.
const gateway = process.env.CANVAS_GATEWAY ?? "127.0.0.1:8787";

export default defineConfig({
  server: {
    proxy: {
      "/ws": { target: `ws://${gateway}`, ws: true },
      "/metrics": { target: `http://${gateway}` },
      "/members": { target: `http://${gateway}` },
    },
  },
});
