# Felix Canvas

A multiplayer drawing canvas whose entire backend is [Felix](https://github.com/gabloe/felix).
Shapes, cursors, presence, history and snapshots all live in Felix streams and
caches — no Postgres, no Redis, no Kafka beside it.

**Status: designed, not yet built.** This repository currently holds the design.
Code lands as the milestones below are built.

## Why it exists

A broker does not argue for itself. Felix can publish at 181 µs p50 over a real
network and hold a publisher's acknowledgement flat while fanning out to 500
subscribers, but those are rows in a table until something uses them.

Felix Canvas is the application that makes them visible:

- **Fanout** — one publish is encoded once and shared with every viewer, so 500
  people watching a room cost the publisher almost nothing.
- **Isolation** — a deliberately throttled client loses frames loudly and
  rebuilds from its last offset, while everyone else is undisturbed.
- **Replay** — the log *is* the document, so you can scrub a room backwards
  through its own history. No server-side session state to replay from.

## How it works

One room is one durable Felix stream plus a few cache keys.

| What | Felix primitive | Name |
|---|---|---|
| Edit operations | Durable stream | `canvas.ops.<room>` |
| Cursors and presence | Ephemeral stream | `canvas.presence.<room>` |
| Compacted snapshot + its log offset | Cache key | `canvas.snap/<room>` |
| Room membership | Cache keys with TTL | `canvas.presence/<room>:<session>` |
| Snapshot worker cursor | Consumer group | group `snapshotter` |

Edits and presence are separate streams because they have opposite
requirements: an edit must never be dropped, and a cursor position from 40 ms
ago is worthless. The edit stream is durable; the presence stream runs in memory
with a drop-new overflow policy.

Room state is a pure fold over the op stream, so two clients that have applied
the same prefix hold the same canvas — which is checkable with a hash rather
than by eye.

See [docs/design.md](docs/design.md) for the full design: join and snapshot
ordering, conflict resolution, failure modes, the browser transport problem, and
the milestone plan.

## Build order

| M | Milestone | Proves |
|---|---|---|
| 0 | WebSocket gateway relaying publish/subscribe | A browser can reach Felix at all |
| 1 | Two browsers, shapes, offset-ordered apply | The log is the document |
| 2 | Snapshotter and the join path | A cold client joins a busy room correctly |
| 3 | Presence, cursors, TTL membership | The ephemeral/durable split is real |
| 4 | Slow-client lane and offset-gap recovery | Isolation and correct rejoin |
| 5 | Time scrubber over the op log | Replay, with no state hiding in the gateway |
| 6 | Per-room token narrowing against a real IdP | Multi-tenancy enforced by the broker |
| 7 | 500-viewer stress; kill the owning broker | Flat fanout and survival of failover |

M0 comes first because Felix speaks raw QUIC and no browser can open a QUIC
connection to it today. Everything else waits on that bridge.

## License

MIT
