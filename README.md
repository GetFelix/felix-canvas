<p align="center">
  <img src="docs/brand/felix-canvas-mark.png" alt="Felix Canvas: the Felix cat with a pen stroke and two cursors" width="200">
</p>

<h1 align="center">Felix Canvas</h1>

<p align="center">
  A self-hosted multiplayer drawing canvas whose entire backend is <a href="https://github.com/gabloe/felix">Felix</a>.<br>
  No Postgres, Redis or Kafka beside it.
</p>

<p align="center">
  <a href="https://github.com/gabloe/felix-canvas/actions/workflows/ci.yml"><img src="https://github.com/gabloe/felix-canvas/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/sync-dark.png">
  <img src="docs/screenshots/sync-light.png" alt="Two people editing one room, with the sync panel open">
</picture>

Shapes, cursors, presence, history and snapshots all live in Felix streams and
caches. You run it yourself: Felix, a stateless gateway, a snapshotter and the web app.

**Status: M0 to M7 done, and M8 but for the Helm chart.** Two browsers draw rectangles, ellipses, lines and pen
strokes in one room and drag the same shape at once. Each one's canvas is a fold
of the room's Felix log in offset order, and both end with the same state hash.
A snapshotter keeps the room's folded state in the Felix cache, so a browser
joining a busy room draws it at once and reads only the recent changes.
Everyone sees everyone else's cursor and name, and a member list that drops a
closed laptop on its own. People sign in with your identity provider, and each
session can reach only the room it opened, enforced by Felix itself.
A tab throttled to 100 kbit/s falls behind alone, says so, and catches up to
the same canvas while everyone else stays live. History mode scrubs a room
back and forth through every change it has had, straight from the log, and
returns to live without missing anything. Killing the Felix broker that holds
a room in the middle of editing costs a moment of "Reconnecting" and no
acknowledged change, and 500 viewers on a room leave the editor's save time
within 15% of what it is alone.
Signed images and a compose install let you run it yourself with your own
identity provider; see [Self-hosting](#self-hosting).

## Why it exists

A broker does not argue for itself. Felix can publish at 181 µs p50 over a real
network and hold a publisher's acknowledgement flat while fanning out to 500
subscribers, but those are rows in a table until something uses them.

Felix Canvas is the application that makes them visible:

- **Fanout.** One publish is encoded once and shared with every viewer. Felix
  delivers over a million messages a second to 500 subscribers on one broker
  with nothing dropped, and the publisher's acknowledgement holds flat at 206 µs.
- **Isolation.** A deliberately throttled client loses frames loudly and
  rebuilds from its last offset, while everyone else is undisturbed.
- **Replay.** The log *is* the document, so you can scrub a room backwards
  through its own history. No server-side session state to replay from.

## How these are normally built

A realtime canvas is normally four systems: a WebSocket tier with sticky sessions
so a room's clients reach the process holding it, Redis pub/sub to fan out when
they do not, Postgres for the document of record, and Kafka added later when
history turns out to matter. That stack works, and most collaborative software you
have used is built from it, but the order of truth is split across all four, and
Redis pub/sub carries no offsets, so a client that misses an update has no way to
learn that it did. Reloading the page is collaborative software's universal
repair for exactly that reason.

Felix Canvas keeps the merge rule those systems already use (last-writer-wins
per shape field, the same rule as Figma) and changes only what sits underneath.
One log per room does the live fanout *and* the history, so catch-up and replay
are the same call, and a missed update is a gap in offsets rather than a wrong
picture nobody notices.

The design chapter [How these are normally built](docs/design.md#how-these-are-normally-built)
has the full comparison, including what the trade costs: a gateway hop for
browsers, no place to keep an ACL, and no offline editing worth the name.

## How it works

One room is one durable Felix stream plus a few cache keys.

| What | Felix primitive | Name |
|---|---|---|
| Edit operations | Durable stream | `canvas.ops.<room>` |
| Cursors and presence | Ephemeral stream | `canvas.presence.<room>` |
| Compacted snapshot + its log offset | Cache key | `canvas.snap.<room>/latest` |
| Who is in the room now | Cache keys with TTL | `canvas.members.<room>/<session>` |
| Who may open the room | Felix RBAC role | `role:room-<room>` |
| Snapshot worker cursor | Consumer group | group `snapshotter` |

Edits and presence are separate streams because they have opposite
requirements: an edit must never be dropped, and a cursor position from 40 ms
ago is worthless. The edit stream is durable; the presence stream runs in memory
with a drop-new overflow policy.

Room state is a pure fold over the op stream, so two clients that have applied
the same prefix hold the same canvas, which is checkable with a hash rather
than by eye.

See [docs/design.md](docs/design.md) for the full design: join and snapshot
ordering, conflict resolution, failure modes, the browser transport problem, and
the milestone plan.

## Build order

| M | Milestone | Proves | Status |
|---|---|---|---|
| 0 | WebSocket gateway relaying publish/subscribe | A browser can reach Felix at all | Done |
| 1 | Two browsers, shapes, offset-ordered apply | The log is the document | Done |
| 2 | Snapshotter and the join path | A cold client joins a busy room correctly | Done |
| 3 | Presence, cursors, TTL membership | The ephemeral/durable split is real | Done |
| 4 | Slow-client lane and offset-gap recovery | Isolation and correct rejoin | Done |
| 5 | Time scrubber over the op log | Replay, with no state hiding in the gateway | Done |
| 6 | Per-room token narrowing against a real IdP | Multi-tenancy enforced by the broker | Done |
| 7 | 500-viewer stress; kill the owning broker | Flat fanout and survival of failover | Done |
| 8 | Images, a compose install, your own IdP, a Helm chart | Anyone can self-host it | Done but the Helm chart |
| 9 | Rich text in shapes, merged when two people type at once | A CRDT rides the same log: snapshots, rejoin and replay still work | |

Each milestone is tracked as a [GitHub milestone](https://github.com/gabloe/felix-canvas/milestones)
with an issue per piece of work.

M0 comes first because Felix is QUIC end to end, and the gateway is what brings
a browser onto that path. What it proves, as tested in CI against the published
Felix images:

- Two WebSocket sessions publish to `canvas.ops.lobby` and both receive all ten
  records in one order, with increasing log offsets, each session's own records
  in the order it sent them.
- An ack carries the same offset the record is delivered at, and subscribing
  from an offset replays the log from there.
- The presence stream relays without offsets, fire-and-forget.
- The gateway reports its browser leg and its Felix leg as separate latency
  histograms.

M1 makes the log the document. What it proves, in CI against the same images:

- Two browsers draw in one room, each sees the other's shapes, and both drag one
  rectangle at the same time. Once neither has an edit in flight, both have
  applied the same log prefix and their state hashes match.
- A third browser that joins afterwards replays the log from offset 0 and
  reaches the same hash.
- Unit tests show that the fold converges under concurrent writes to one field
  and to different fields, and that records delivered out of order and twice
  end in the same state as in-order delivery.
- Each session's sequence numbers come from the Felix counter
  `canvas.seq.<room>/<session>`, reserved through the gateway.

M2 makes joining cheap. What it proves, in CI against the same images:

- The snapshotter reads the op log through the consumer group `snapshotter`,
  folds it with the same `model/` code as the browser, and writes the state and
  its offset as one value to `canvas.snap.<room>`. It acknowledges records only
  after the write, and unit tests show a crash between writes ends in the same
  snapshot.
- A browser subscribes at the live tail before it reads the snapshot. A unit
  test publishes while the snapshot read is in flight and checks that the
  change arrives on the live subscription, with no second read of the log, and
  an integration test checks the same against Felix.
- A browser whose place in the log has been trimmed rebuilds from the snapshot
  through the same code path and keeps its unsaved edits.
- A cold browser joining a room of 10,000 ops while another session edits draws
  its first correct frame in under 500 ms and ends with the same state hash as a
  browser that saw every op live.

M3 splits what must last from what must be fast. What it proves, in CI against
the same images:

- Two browsers see each other's cursors follow the pointer, with names, through
  the in-memory presence stream. Each browser sends at most one cursor message a
  frame, fire-and-forget; unit tests pin the pacing down.
- Each session keeps a member entry, `canvas.members.<room>/<session>`, with a
  30 second TTL that it refreshes every 10 seconds. Browsers read the list
  through one retained prefix watch. A tab that closes deletes its entry at
  once; a tab that crashes drops out of the other browser's list when the
  entry expires, not before.
- A person keeps their colour and shows once in the list across a reload,
  because colours come from an id the browser keeps, not from the session.
- The gateway lists, watches and expires member entries against a real broker.

M4 shows that a slow client hurts only itself. What it proves, in CI against
the same images:

- The Sync panel's "Slow connection" switch has the gateway read that tab's
  subscriptions at 100 kbit/s. Felix's bounded queue for that subscriber drops
  new changes; the gateway drops nothing.
- The browser treats a jump in offsets as a loss, shows "Your connection is
  slow" with a count, reads the missing changes from the log, and ends with the
  same state hash as the other browsers. A loss at the very end of a burst,
  which no later change reveals, is caught from the applied count peers send
  with their presence.
- With one of three browsers throttled under 300 changes a second, the others'
  save time stays under 50 ms at the median and within 1.5 times plus 10 ms of
  what it was without the throttled browser.
- A gateway integration test shows a throttled connection seeing a gap while
  another connection on the same gateway receives every record.

M5 makes history a fold of the log. What it proves, in CI against the same
images:

- History mode reads the room's log from offset 0 over a second gateway
  connection, narrowed to the room like the first, and the gateway keeps
  nothing about it. The live session keeps running, so going back to live
  shows the changes made meanwhile.
- On a 10,000-change room, a browser drags the playhead back and forth, and at
  every stop the canvas has the same state hash as a fresh fold of the log to
  that change. History loads within 0.5 ms per change and the slowest seek
  stays under 50 ms; both measure several times lower.
- A unit test checks every position of a 3,000-op log, in any order, against a
  fresh fold, including a history that starts at a snapshot because retention
  trimmed the log below it.
- The scrubber reaches as far back as the log does. Felix keeps logs unless a
  broker-wide limit is set, so that is the room's first change by default
  ([design.md](docs/design.md#how-far-back-the-scrubber-reaches)).

M6 puts each session in one room and lets Felix keep it there. What it proves,
in CI against the same images:

- The browser signs in with the authorization code flow and PKCE, and joins a
  room with its ID token. The gateway exchanges that token at the Felix control
  plane for a Felix token narrowed to the room's two streams and three caches,
  and opens that session's own Felix connection with it.
- Who may open a room is a Felix RBAC role per room, so the control plane
  refuses the exchange for anyone else. A refused browser shows "You don't have
  access to this canvas" with a way to switch account.
- A token for the lobby, held by someone who may also open the studio, is
  refused by the broker when it publishes to, subscribes to, reads or writes
  anything of the studio's. The test talks to the broker directly, and fails if
  the gateway stops narrowing.

M7 checks that the room survives a broker and a crowd. What it proves:

- `dev/up.sh --cluster` starts three Felix brokers that replicate every
  room, with a majority acknowledging each change. In CI, two browsers edit
  while a third watches history, and the broker that owns the room's log is
  killed. Editing resumes on another broker; both editors end with the same
  state hash, which is also the fold of the log read back from the start;
  every edit either browser saw acknowledged is in that log; and the history
  view, the snapshotter and a browser that joins afterwards all agree.
- Edits that were in flight when the broker died are sent again with the same
  `(sid, seq)`. A typical run sends about 400 to 700 edits, and a few hundred
  of them land twice; the fold drops every repeat.
- With 500 viewers subscribed to the room, the editing browser's
  publish-to-acknowledgement median stays within 15% of the one-viewer case.

### Performance

Measured on a 4-core GitHub Codespace (16 GB) on 2026-10-03, with Felix
0.6.0-preview from the published images, the gateway as a release build,
headless Chromium, the snapshotter and the page server all on that one host.
That host is shared, so these are what the design looks like on a laptop-class
machine, not Felix's ceiling. The commands are in
[development.md](docs/development.md#measuring-the-performance-targets).

| Path | Target | Codespace, one host |
|---|---|---|
| Local echo, input to own pixel | < 16 ms | p50 0.5 ms, p99 14.7 ms. Headless Chromium draws without waiting for the display; a 60 Hz screen adds up to one frame |
| Edit visible to another client | < 50 ms p50, < 150 ms p99 | p50 7.0 ms, p99 21.0 ms |
| Cursor visible to another client | < 40 ms p50 | p50 8.1 ms |
| Join a 10,000-change room | < 500 ms to first correct frame | 116 ms |
| Fanout, 1 to 500 viewers | Publish p50 within 15% | 13.7 ms with 1, 15.2 ms with 500: within 10.9%. Each of the 499 extra viewers received all 900 edits, none dropped |
| Snapshot lag | < 1,000 changes behind | p50 253, max 498, while a writer adds 300 changes a second |
| Owning broker killed | Editing resumes, nothing acknowledged is lost | 5 of 5 runs on the three-broker dev stack: every acknowledged edit kept, all editors on one state hash. The longest wait between acknowledged edits was 5.7 to 12.8 s, median 6.0 s, with the dev stack's 3 s liveness window; 130 to 400 edits a run landed twice and were absorbed |

The fanout run alternates 1 viewer and 500 three times, 300 edits each, one
every 20 ms. Most of the 13 ms publish time is the broker writing each change
to disk before it acknowledges, on the Codespace's disk. The 499 viewers share
one Felix client and one connection, which is how `felix-loadgen` holds them
too.

Still to run on dedicated hardware, with Felix on its own machines and the
browsers elsewhere in the same region:

| Path | Why it needs that run |
|---|---|
| Fanout, 1 to 500 viewers | The viewers should be separate clients on their own connections, from more than one host, so the broker's fanout is measured rather than this host's CPU |
| Edit and cursor visible to another client | Over a real network hop between browser, gateway and broker |
| Local echo | In a headed browser on a real display |
| Owning broker killed | With Felix's default liveness settings and brokers on separate machines |

M8 makes it something you can run. What it proves, in CI:

- Every pull request builds both images, `felix-canvas` (the gateway, serving
  the web page from the same origin) and `felix-canvas-snapshotter`, on amd64
  and arm64 runners. A `v*` tag pushes them to GHCR as one multi-arch image
  each and signs them with cosign, the way Felix releases its own.
- The release compose file starts Felix (its control plane keeping metadata
  in its own Raft log, so there is no database), both canvas images and a
  seed from those images, and two browsers draw together in it.
- The same install signed in through Dex instead of the development page, with
  members named by email, which is the path for any other OpenID Connect
  provider.

## Repository layout

| Path | What |
|---|---|
| `gateway/` | The edge gateway: Rust, `axum` and `felix-client`. Stateless; it relays bytes. `examples/viewers.rs` holds the viewers for the fanout measurement |
| `model/` | The op schema, its MessagePack encoding, the fold, the snapshot format and the state hash, shared by the browser and the snapshotter |
| `snapshotter/` | Node service: reads a room's log through a consumer group with the `felix-client` npm package and keeps its snapshot in the cache |
| `web/` | The browser client: Canvas2D renderer, tools, the op pipeline and join path, and the Playwright tests |
| `dev/` | Felix for local runs and CI: Docker Compose over the published images with one broker or three, a stand-in IdP, and the seed script |
| `docker/` | The Dockerfiles for the two images |
| `deploy/compose/` | The release compose file, its settings, and a Dex example |
| `docs/design.md` | The design: data model, editing and join rules, failure modes, targets |
| `docs/protocol.md` | The browser to gateway protocol |
| `docs/ux.md` | The UX and visual design brief the interface is built from |
| `docs/development.md` | Where to run it, the lockfile rule, the dev stack and CI |
| `docs/self-hosting.md` | Installing, your own IdP, TLS, backups, upgrades, and every setting |
| `docs/brand/` | The Felix Canvas mark, adapted from the Felix logo |
| `CONTRIBUTING.md` | How code, comments and pull requests should read |

## Running locally

You need Docker, Rust (the toolchain in `rust-toolchain.toml` installs itself),
and Node 24.

1. Start Felix. This pulls `ghcr.io/gabloe/felix-broker` and
   `felix-controlplane` at `0.6.0-preview`, starts a stand-in sign-in service on
   `127.0.0.1:9400`, creates the `lobby` and `studio` rooms, and writes the
   snapshotter's token and the broker's certificate to `dev/state/`:

   ```bash
   dev/up.sh
   ```

   Each run starts from an empty log. `docker compose -f dev/docker-compose.yml down -v`
   stops it.

2. Start the gateway, which listens on `127.0.0.1:8787`. It has no token of its
   own; each browser's sign-in is exchanged for one when it joins:

   ```bash
   export CANVAS_FELIX_CA_FILE=dev/state/broker-cert.pem
   cargo run -p felix-canvas-gateway
   ```

3. In another shell, build the shared model and start the snapshotter, which
   answers on `127.0.0.1:8788` with how far it has got:

   ```bash
   npm install
   npm run build -w @felix-canvas/model -w @felix-canvas/snapshotter
   export CANVAS_FELIX_TOKEN="$(cat dev/state/snapshotter.token)"
   export CANVAS_FELIX_CA_FILE="$PWD/dev/state/broker-cert.pem"
   npm start -w @felix-canvas/snapshotter
   ```

4. In another shell, start the page, which proxies the gateway's routes:

   ```bash
   npm run dev -w @felix-canvas/web
   ```

5. Open <http://localhost:5173> in two windows, continue as `ana` or `ben`, and
   draw: <kbd>R</kbd> for a rectangle, <kbd>O</kbd> an ellipse, <kbd>L</kbd> a
   line, <kbd>P</kbd> the pen, <kbd>V</kbd> to select and drag, and <kbd>?</kbd>
   for every shortcut. The chip at the top right shows how long your changes
   take to save; click it for the sync details, including the canvas version
   both windows should share. `?room=studio` opens the other room, which only
   `ana` may open.

`curl -s 127.0.0.1:8787/metrics` shows the latency of both legs. With the variable
from step 2 exported, the integration tests run against the same stack:

```bash
cargo test -- --include-ignored
```

The browser tests start their own gateway, snapshotter and page against the
running stack:

```bash
npx -w @felix-canvas/web playwright install chromium
npm run test:e2e -w @felix-canvas/web
```

[docs/self-hosting.md](docs/self-hosting.md#configuration-reference) lists every
variable the gateway, the snapshotter and the seed read.

## Self-hosting

Each release publishes two signed, multi-arch images to GHCR and a compose file
that runs them with Felix:

```bash
git clone --depth 1 --branch v0.1.0 https://github.com/gabloe/felix-canvas
cd felix-canvas/deploy/compose
# change FELIX_BOOTSTRAP_TOKEN and FELIX_RAFT_PEER_TOKEN in .env first
docker compose up -d
```

Then open <http://localhost:8787> and continue as `ana` or `ben`. The
[self-hosting guide](docs/self-hosting.md) covers signing in with your own
OpenID Connect provider, rooms and members, TLS, backups of the Felix data,
upgrades, and every setting.

## License

MIT
