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
`dev/docker-compose.yml`, creates the room's streams and the single-shard
`canvas.seq`, `canvas.snap` and `canvas.presence` caches (a prefix watch reads
one shard, and the member list is one), and writes the gateway's and the snapshotter's tokens and
the broker's certificate to `dev/state/`. Every run starts from an empty log.

The snapshotter reads the same `CANVAS_*` variables as the gateway, with its own
token, plus four of its own:

| Variable | Default | Meaning |
|---|---|---|
| `CANVAS_SNAPSHOTTER_LISTEN` | `127.0.0.1:8788` | Where it answers `GET /` with `{"room", "applied", "saved"}`: the last offset folded and the last one a stored snapshot holds |
| `CANVAS_SNAPSHOT_EVERY_OPS` | `500` | Write a snapshot once this many records are folded but not saved |
| `CANVAS_SNAPSHOT_EVERY_MS` | `30000` | Or once the oldest of them has waited this long |
| `CANVAS_SNAPSHOTTER_CLAIM_WAIT_MS` | `30000` | How long it waits after starting before it reads, so records an earlier run claimed come back first. Match the broker's `FELIX_GROUP_VISIBILITY_TIMEOUT_MS` |

Three settings there exist only because of Felix gaps, each filed upstream:

| Setting | Why | Felix issue |
|---|---|---|
| `dev/idp.mjs`, a stand-in identity provider | Felix issues client tokens only in exchange for an IdP token | [#954](https://github.com/gabloe/felix/issues/954) |
| `FELIX_EXCHANGE_TOKEN_TTL_SECONDS=86400` | A standalone broker reads its node token once, so the default 900 s would end a dev session after 15 minutes | [#955](https://github.com/gabloe/felix/issues/955) |
| `FELIX_ACK_ON_COMMIT=true` | Only an ack after the write carries the record's offset, and that is a broker-wide setting | [#956](https://github.com/gabloe/felix/issues/956) |

## What CI checks

| Job | Checks |
|---|---|
| Rust lint and unit tests | `cargo fmt --check`, `cargo clippy -D warnings`, unit tests |
| Gateway against Felix | Starts the dev stack and runs the gateway's integration tests against it |
| TypeScript | The lockfile rule above, `npm ci`, prettier, the build, type checks and unit tests for `model/`, `web/` and `snapshotter/` |
| Two browsers against Felix | Starts the dev stack, the gateway, the snapshotter and the page, and runs the Playwright tests in `web/e2e/`: two browsers converging, and a cold browser joining a 10,000-op room, and two people seeing each other's cursors and member list. They run one at a time because they share a room, and the gateway runs with a 6 second member TTL so the crashed-tab test stays short |

## Milestones and issues

Work follows the build order in [design.md](design.md#build-order). Each milestone
is a [GitHub milestone](https://github.com/gabloe/felix-canvas/milestones), each
piece of it is an issue, and each milestone lands as one pull request that closes
its issues. When Felix gets in the way, file an issue on
[Felix](https://github.com/gabloe/felix/issues) and link it from the pull request.
