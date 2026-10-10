import { defineConfig } from "vite";

// The dev server proxies the gateway's routes and the rooms service's /api/,
// so the page reaches both on its own origin in development exactly as it
// would behind a reverse proxy.
const gateway = process.env.CANVAS_GATEWAY ?? "127.0.0.1:8787";
const rooms = process.env.CANVAS_ROOMS_SERVICE ?? "127.0.0.1:8789";

export default defineConfig({
  // The page signs in with top-level await before it joins.
  build: { target: "es2022" },
  server: {
    proxy: {
      "/ws": { target: `ws://${gateway}`, ws: true },
      "/metrics": { target: `http://${gateway}` },
      "/members": { target: `http://${gateway}` },
      "/oidc": { target: `http://${gateway}` },
      "/api": { target: `http://${rooms}` },
    },
  },
});
