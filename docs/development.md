# Development

How to work on Felix Canvas: where to run it, the rules the lockfile follows, and
what CI checks. The [README](../README.md#running-locally) has the commands for a
local run.

## Where to run it

Everything runs on one machine: Docker for Felix, Rust for the gateway, and Node
for `model/`, `web/` and the snapshotter.

| Environment | When | Notes |
|---|---|---|
| Your machine | Docker and npmjs.org are both available | Follow the README. |
| GitHub Codespace | npmjs.org is blocked, or you don't want Docker locally | The default image has Node and Docker. Install Rust with rustup; `rust-toolchain.toml` pins the version. Use the 4-core machine: the Felix images, the gateway build and Playwright run side by side. |
| CI | Every push and pull request | The same checks as below, against the published Felix images. |

A Codespace can be driven from another machine. Write an ssh config once, then
sync edits with rsync and run commands over `gh`:

```bash
gh codespace ssh -c <name> --config > ~/.ssh/codespaces
rsync -az --exclude .git --exclude node_modules --exclude target \
  -e "ssh -F $HOME/.ssh/codespaces" ./ cs.<name>.main:/workspaces/felix-canvas/
gh codespace ssh -c <name> -- 'cd /workspaces/felix-canvas && npm test'
```

Delete the Codespace when the work is merged.

## npm registry and the lockfile

`.npmrc` pins `registry=https://registry.npmjs.org/`, and the project file wins
over a user-level `~/.npmrc`. Don't install through a mirror. A corporate mirror
can rewrite `package-lock.json` to resolve from private feeds that CI can't reach,
and can downgrade integrity hashes from sha512 to sha1.

CI fails if any lockfile entry resolves from anywhere but npmjs.org or lacks a
sha512 hash. Generate lockfile changes on a machine that reaches npmjs.org, or in
a Codespace.

## The Felix dev stack

`dev/up.sh` starts the broker and control plane from
`ghcr.io/gabloe/felix-broker` and `felix-controlplane` at the version pinned in
`dev/docker-compose.yml`, along with `dev/idp.mjs`, a stand-in OpenID Connect
provider on `127.0.0.1:9400`. Its sign-in page signs in anyone who picks a name.
The seed then creates two rooms and decides who may open them:

| Room | Members |
|---|---|
| `lobby` | `ana`, `ben` |
| `studio` | `ana` |

For each room it creates the two streams, the single-shard
`canvas.seq.<room>`, `canvas.snap.<room>` and `canvas.members.<room>` caches (a
prefix watch reads one shard, and the member list is one), and the role
`role:room-<room>`, assigned to the members. It writes the broker's credential,
the snapshotter's token and the broker's certificate to `dev/state/`. Every run
starts from an empty log. Open <http://localhost:5173/?room=studio> as `ben` to
see a refused room.

The gateway has no token of its own: each browser session gets one from the
control plane when it joins. It reads these variables:

| Variable | Default | Meaning |
|---|---|---|
| `CANVAS_LISTEN` | `127.0.0.1:8787` | Where browsers connect |
| `CANVAS_FELIX_BROKERS` | `127.0.0.1:5000` | Comma-separated broker addresses |
| `CANVAS_FELIX_SERVER_NAME` | `localhost` | The name the broker's certificate is checked against |
| `CANVAS_FELIX_CA_FILE` | the platform trust store | PEM certificates to trust for the broker |
| `CANVAS_FELIX_CONTROL_PLANE` | `http://127.0.0.1:8443` | The Felix control plane, where sign-ins are exchanged |
| `CANVAS_TENANT` | `canvas` | The Felix tenant |
| `CANVAS_NAMESPACE` | `default` | The Felix namespace the rooms live in |
| `CANVAS_OIDC_ISSUER` | `http://127.0.0.1:9400` | The identity provider browsers sign in with |
| `CANVAS_OIDC_CLIENT_ID` | `felix-canvas` | The client registered for the canvas at that provider |
| `CANVAS_MEMBER_TTL_SECONDS` | `30` | How long a member entry outlives its last refresh |

The snapshotter serves one room. It reads `CANVAS_FELIX_BROKERS`,
`CANVAS_FELIX_SERVER_NAME`, `CANVAS_FELIX_CA_FILE`, `CANVAS_TENANT` and
`CANVAS_NAMESPACE` as above, `CANVAS_FELIX_TOKEN` for its own token,
`CANVAS_ROOM` (default `lobby`), and four more:

| Variable | Default | Meaning |
|---|---|---|
| `CANVAS_SNAPSHOTTER_LISTEN` | `127.0.0.1:8788` | Where it answers `GET /` with `{"room", "applied", "saved"}`: the last offset folded and the last one a stored snapshot holds |
| `CANVAS_SNAPSHOT_EVERY_OPS` | `500` | Write a snapshot once this many records are folded but not saved |
| `CANVAS_SNAPSHOT_EVERY_MS` | `30000` | Or once the oldest of them has waited this long |
| `CANVAS_SNAPSHOTTER_CLAIM_WAIT_MS` | `30000` | How long it waits after starting before it reads, so records an earlier run claimed come back first. Match the broker's `FELIX_GROUP_VISIBILITY_TIMEOUT_MS` |

Four settings there exist only because of Felix gaps:

| Setting | Why | Felix issue |
|---|---|---|
| `GET /token?sub=` on `dev/idp.mjs` | The seed and the tests need tokens without a browser, and Felix issues them only in exchange for an IdP token | [#954](https://github.com/gabloe/felix/issues/954) |
| `FELIX_EXCHANGE_TOKEN_TTL_SECONDS=86400` | A standalone broker reads its node token once, so the default 900 s would end a dev session after 15 minutes | [#955](https://github.com/gabloe/felix/issues/955) |
| `FELIX_ACK_ON_COMMIT=true` | Only an ack after the write carries the record's offset, and that is a broker-wide setting | [#956](https://github.com/gabloe/felix/issues/956) |
| `FELIX_SUB_QUEUE_BOUND=8192` | The broker's writer queue is per connection and holds one entry per subscription per change, so at the default of 64 a client holding 100 subscriptions on one connection loses changes even at 50 a second, and no metric counts the loss | Not filed yet |

### Three brokers

`dev/up.sh --cluster` lays `dev/docker-compose.cluster.yml` over the same stack
and starts three brokers instead of one. The seed then gives every stream and
cache three replicas, and the op log and caches `Quorum` consistency, so a
change is acknowledged only once two of the three brokers hold it. The control
plane runs with short liveness windows (a 500 ms heartbeat and a 3 second
expiry), so a stopped broker's rooms move within a few seconds rather than the
default of about twenty.

| Broker | Client port (UDP) | Health |
|---|---|---|
| `broker` (node `broker-1`) | `127.0.0.1:5000` | `127.0.0.1:8080` |
| `broker-2` | `127.0.0.1:5010` | `127.0.0.1:8081` |
| `broker-3` | `127.0.0.1:5020` | `127.0.0.1:8082` |

Each broker signs its own certificate, and `up.sh` concatenates the three into
`dev/state/broker-cert.pem`. Give the gateway and the snapshotter every broker:

```bash
dev/up.sh --cluster
export CANVAS_FELIX_CA_FILE=dev/state/broker-cert.pem
export CANVAS_FELIX_BROKERS=127.0.0.1:5000,127.0.0.1:5010,127.0.0.1:5020
```

`GET /v1/placement/replication` on the control plane, with the broker's token
from `dev/state/node.token`, names the broker that owns each room's op log.
The failover test reads it there, kills that broker's container with
`docker kill`, and starts it again at the end:

```bash
CANVAS_FELIX_CLUSTER=1 npm run test:e2e -w @felix-canvas/web -- failover
```

The brokers trust each other without certificates
(`FELIX_INTERNAL_ALLOW_UNAUTHENTICATED`), which is fine on a compose network
only the brokers share and nowhere else.

## What CI checks

| Job | Checks |
|---|---|
| Rust lint and unit tests | `cargo fmt --check`, `cargo clippy -D warnings`, unit tests |
| Gateway against Felix | Starts the dev stack and runs the gateway's integration tests against it, including the narrowing test: a token for one room is refused by the broker on another room's streams, counters, snapshot and member list |
| TypeScript | The lockfile rule above, `npm ci`, prettier, the build, type checks and unit tests for `model/`, `web/` and `snapshotter/` |
| Two browsers against Felix | Starts the dev stack, the gateway, the snapshotter and the page, and runs the Playwright tests in `web/e2e/`: two browsers converging, a cold browser joining a 10,000-op room, two people seeing each other's cursors and member list, a person who is not a member being shown that they cannot open a room, a throttled browser catching up while the others' save time holds, and a browser scrubbing a 10,000-change room in the studio, checking each stop against a fresh fold, within a time bound. Each browser signs in through the stand-in provider's page. They run one at a time because they share a room, and the gateway runs with a 6 second member TTL so the crashed-tab test stays short |
| Failover against a Felix cluster | Starts the three-broker stack and runs `web/e2e/failover.e2e.ts`: two browsers edit while a third watches the room's history, the broker that owns the room's op log is killed, and both editors end with the same state hash, which is also the fold of the log read back from offset 0. Every edit a browser saw acknowledged is in that log, the history view reaches the same state, the snapshotter carries on, and a browser that joins afterwards matches. It is a separate job, and not a required check, because it needs three brokers and stops one |

## Measuring the performance targets

Two Playwright specs measure rather than check, so they skip unless asked.
Run them against a release gateway: a debug build adds its own latency, and
Playwright reuses a gateway that is already listening.

```bash
dev/up.sh
export CANVAS_FELIX_CA_FILE=$PWD/dev/state/broker-cert.pem
cargo build --release -p felix-canvas-gateway --bin felix-canvas-gateway --example viewers
target/release/felix-canvas-gateway &

# Local echo, edit and cursor visibility, snapshot lag and a cold join.
CANVAS_MEASURE=1 npm run test:e2e -w @felix-canvas/web -- targets

# Publish latency with 1 viewer and with 500.
CANVAS_FANOUT_VIEWERS=500 npm run test:e2e -w @felix-canvas/web -- fanout
```

Each prints a row per target and fails if a target is missed. The README
records the numbers and the machine they came from.

| Target | How it is timed |
|---|---|
| Local echo | From the input event reaching the page to the end of drawing the frame that shows its effect |
| Edit visible to another client | From the edit being made (the `at` time stamp in its op) to the end of drawing the frame that shows it in the other browser. Both browsers share one clock |
| Cursor visible to another client | A browser's own presence message, from publish to its delivery back, which is the path every other viewer's copy takes |
| Join a 10,000-change room | From starting to join until the first frame drawn from the snapshot plus the changes after it |
| Snapshot lag | The newest change's offset minus the offset the stored snapshot holds, sampled while a writer adds 300 changes a second |
| Fanout | The editing browser's publish to Felix's acknowledgement, alternating 1 viewer and the full count three times |

The fanout viewers come from `gateway/examples/viewers.rs`: one Felix client
holding a subscription per viewer to the room's op log, from the live tail,
each counting the changes it receives and any offsets skipped. It does the
same thing as `felix-loadgen --scenario pubsub --fanout N` on the subscriber
side. `felix-loadgen` itself cannot be used: its pubsub scenario always runs
its own publisher at full speed into the stream, so it measures a saturated
room rather than one person editing, and its subscribers stop once they have
counted the publisher's records.

The editing browser is one of the viewers, so the 1-viewer case starts no
extra subscriptions and the 500-viewer case starts 499. Every gateway session
has its own Felix client, because Felix ties a connection to one token
([felix#969](https://github.com/gabloe/felix/issues/969)). The gateway opens
one publish, one subscription and one cache connection per session rather
than Felix's default 4, 8 and 8, which against the broker's limit of 512
connections per address would stop one gateway host at about 25 sessions.

## Milestones and issues

Work follows the build order in [design.md](design.md#build-order). Each milestone
is a [GitHub milestone](https://github.com/gabloe/felix-canvas/milestones), each
piece of it is an issue, and each milestone lands as one pull request that closes
its issues. When Felix gets in the way, file an issue on
[Felix](https://github.com/gabloe/felix/issues) and link it from the pull request.
