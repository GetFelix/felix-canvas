import { defineConfig } from "vite";

// The dev server proxies /ws to the gateway, so the page reaches it on its own
// origin in development exactly as it would behind a reverse proxy.
export default defineConfig({
  server: {
    proxy: {
      "/ws": { target: process.env.CANVAS_GATEWAY ?? "ws://127.0.0.1:8787", ws: true },
    },
  },
});
