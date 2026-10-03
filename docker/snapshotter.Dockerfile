# syntax=docker/dockerfile:1.7
# The snapshotter. It also carries the seed (dev/seed.mjs) and the stand-in
# identity provider (dev/idp.mjs), so a deployment runs them from this image:
#   node dev/seed.mjs, node dev/idp.mjs
# Build from the repository root: docker build -f docker/snapshotter.Dockerfile .

FROM node:24-trixie-slim AS build
WORKDIR /src
# Every workspace's manifest, or npm ci refuses the lockfile.
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY model/package.json model/
COPY web/package.json web/
COPY snapshotter/package.json snapshotter/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include-workspace-root -w @felix-canvas/model -w @felix-canvas/snapshotter
COPY model model
COPY snapshotter snapshotter
RUN npm run build -w @felix-canvas/model -w @felix-canvas/snapshotter

# Trixie, not bookworm or alpine: felix-client's native addon needs glibc 2.38.
FROM node:24-trixie-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY model/package.json model/
COPY web/package.json web/
COPY snapshotter/package.json snapshotter/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev -w @felix-canvas/snapshotter
COPY --from=build /src/model/dist model/dist
COPY --from=build /src/snapshotter/dist snapshotter/dist
COPY dev/seed.mjs dev/idp.mjs dev/
ENV NODE_ENV=production \
    CANVAS_SNAPSHOTTER_LISTEN=0.0.0.0:8788
USER 65532:65532
EXPOSE 8788/tcp
ENTRYPOINT ["node"]
CMD ["snapshotter/dist/main.js"]
