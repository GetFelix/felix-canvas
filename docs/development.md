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

Three settings there exist only because of Felix gaps, each filed upstream:

| Setting | Why | Felix issue |
|---|---|---|
| `GET /token?sub=` on `dev/idp.mjs` | The seed and the tests need tokens without a browser, and Felix issues them only in exchange for an IdP token | [#954](https://github.com/gabloe/felix/issues/954) |
| `FELIX_EXCHANGE_TOKEN_TTL_SECONDS=86400` | A standalone broker reads its node token once, so the default 900 s would end a dev session after 15 minutes | [#955](https://github.com/gabloe/felix/issues/955) |
| `FELIX_ACK_ON_COMMIT=true` | Only an ack after the write carries the record's offset, and that is a broker-wide setting | [#956](https://github.com/gabloe/felix/issues/956) |

## What CI checks

| Job | Checks |
|---|---|
| Rust lint and unit tests | `cargo fmt --check`, `cargo clippy -D warnings`, unit tests |
| Gateway against Felix | Starts the dev stack and runs the gateway's integration tests against it, including the narrowing test: a token for one room is refused by the broker on another room's streams, counters, snapshot and member list |
| TypeScript | The lockfile rule above, `npm ci`, prettier, the build, type checks and unit tests for `model/`, `web/` and `snapshotter/` |
| Two browsers against Felix | Starts the dev stack, the gateway, the snapshotter and the page, and runs the Playwright tests in `web/e2e/`: two browsers converging, a cold browser joining a 10,000-op room, two people seeing each other's cursors and member list, a person who is not a member being shown that they cannot open a room, and a throttled browser catching up while the others' save time holds. Each browser signs in through the stand-in provider's page. They run one at a time because they share a room, and the gateway runs with a 6 second member TTL so the crashed-tab test stays short |

## Milestones and issues

Work follows the build order in [design.md](design.md#build-order). Each milestone
is a [GitHub milestone](https://github.com/gabloe/felix-canvas/milestones), each
piece of it is an issue, and each milestone lands as one pull request that closes
its issues. When Felix gets in the way, file an issue on
[Felix](https://github.com/gabloe/felix/issues) and link it from the pull request.
