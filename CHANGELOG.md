# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Felix Canvas is pre-1.0: the browser protocol, the op format and the install
settings may change between minor versions. Each release notes the Felix
version it was tested against.

## [Unreleased]

### Changed

- Built on Felix 0.6.0-preview.4: the snapshotter uses `felix-client`
  0.6.0-preview.4, and the dev stack, the compose install and the chart's CI
  run the 0.6.0-preview.4 images. The gateway stays on felix-gateway 0.1.0,
  which negotiates capabilities with the newer broker.
- `dev/up.sh` and the failover test run on Docker or Podman, and the docs show
  the Podman commands.

## [0.2.0] - 2026-10-04

Tested against Felix 0.6.0-preview.2, which the install now pins. Felix images
come from `ghcr.io/getfelix`. Upgrading means renaming any `CANVAS_*` gateway
override to `GATEWAY_*` (see below).

### Changed

- The gateway is now the published felix-gateway 0.1.0. The canvas image is
  built on `ghcr.io/getfelix/felix-gateway:0.1.0`, the page uses
  `felix-gateway-client` from npm, and `gateway/` and `packages/gateway-client/`
  are gone. The gateway reads `GATEWAY_*` variables instead of `CANVAS_*`; the
  compose file and the chart set them, but a gateway override such as
  `gateway.extraEnv` that sets `CANVAS_*` must be renamed. The image's scope
  file moved to `/etc/felix-gateway/scope.toml`.
- The snapshotter uses `felix-client` 0.6.0-preview.2.

## [0.1.0] - 2026-10-03

The first release. Tested against Felix 0.6.0-preview.

### Added

- A stateless Rust gateway that serves the web page and relays each browser's
  WebSocket session to Felix over QUIC. (#2)
- Shapes on a shared canvas: rectangles, ellipses, lines and pen strokes. A
  room's canvas is the fold of its op log in offset order, so browsers that have
  applied the same records hold the same canvas and can confirm it with a state
  hash. Two people can drag the same shape at once. (#29)
- Snapshots and fast joins. A Node snapshotter reads each room's log through a
  Felix consumer group, folds it with the same `model/` code as the browser,
  and keeps the result in the Felix cache. A joining browser draws from the
  snapshot and reads only the changes after it. (#37)
- Live cursors with names, and a member list kept as cache keys with a TTL, so
  a closed or crashed tab drops out on its own. (#36)
- Slow-client isolation and gap recovery. A browser that misses records sees
  the jump in offsets, says it is behind, and catches up to the same canvas
  while everyone else stays live. (#40)
- A history mode that scrubs a room back and forth through every change and
  returns to live without missing anything. (#41)
- Per-room authorization. Browsers sign in through any OpenID Connect provider,
  the gateway exchanges the sign-in for a Felix token narrowed to one room, and
  the broker refuses that token on every other room's streams, counters,
  snapshot and member list. (#39)
- Scale and failover: measured publish latency with 500 viewers, and a
  three-broker setup in which editing carries on when the broker holding a
  room's log is killed, with no acknowledged change lost. (#53)
- Release images `ghcr.io/getfelix/felix-canvas` and
  `ghcr.io/getfelix/felix-canvas-snapshotter` for `linux/amd64` and
  `linux/arm64`, signed with cosign; a Docker Compose install with no database
  beside Felix; a Dex example for your own identity provider; and a Helm chart
  that installs next to the Felix chart. (#51, #52)
- Rich text in text boxes and inside rectangles and ellipses: bold, italic,
  underline, links, four sizes, a colour palette, headings and nested lists.
  Each body is a Yjs document whose updates are ordinary ops on the log, so
  snapshots, rejoin and history cover text too. Two people can type in one box
  at once and see each other's carets. (#56, #57, #58)

### Fixed

- A person's name and colour come from the account they signed in with.
  Two accounts signed in from windows of one browser were shown as one person,
  because the name and identity lived in shared local storage. (#55)
