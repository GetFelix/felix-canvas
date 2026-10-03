# Self-hosting Felix Canvas

How to run Felix Canvas on your own machines: the compose install, signing in
with your own identity provider, TLS, backups, upgrades, and every setting the
gateway, the snapshotter and the seed read.

## What runs

| Service | Image | Holds state? | Job |
|---|---|---|---|
| `gateway` | `ghcr.io/gabloe/felix-canvas` | No | Serves the web page and `/ws` from one origin, exchanges each browser's sign-in for a Felix token narrowed to one room, and relays to Felix |
| `snapshotter` | `ghcr.io/gabloe/felix-canvas-snapshotter` | No | Keeps each room's folded state in the Felix cache, so joining a busy room is fast |
| `broker` | `ghcr.io/gabloe/felix-broker` | Yes, `felix-data` | Felix: every room's op log, snapshots, member list and counters |
| `controlplane` | `ghcr.io/gabloe/felix-controlplane` | In Postgres | Felix: the tenant, rooms, roles and token exchange |
| `postgres` | `postgres` | Yes, `postgres-data` | The control plane's store |
| `seed` | the snapshotter image | No | Runs at each start: creates the tenant, the rooms and their roles, and writes the broker's and snapshotter's tokens |
| `tokens` | the snapshotter image | No | Signs in the seed's service accounts; never published |
| `certs` | the gateway image | Writes `state` | Makes the broker a TLS certificate on first start |
| `idp` | the snapshotter image | No | The development sign-in page, while you try it out |

Both canvas images are built for `linux/amd64` and `linux/arm64` and signed
with cosign by the release workflow. To check one before you run it:

```bash
cosign verify ghcr.io/gabloe/felix-canvas:0.1.0 \
  --certificate-identity-regexp 'https://github.com/gabloe/felix-canvas/.github/workflows/images.yml@refs/tags/v.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Install with Docker Compose

You need Docker with Compose 2.20 or later, and about 2 cores and 2 GB of memory.

1. Get the compose file and its settings for a release. They are in
   `deploy/compose/` of the release's source:

   ```bash
   git clone --depth 1 --branch v0.1.0 https://github.com/gabloe/felix-canvas
   cd felix-canvas/deploy/compose
   ```

2. Edit `.env`. Change `FELIX_BOOTSTRAP_TOKEN` and `POSTGRES_PASSWORD` before
   the first start: the bootstrap token can create tenants and cluster
   credentials.

3. Start it:

   ```bash
   docker compose up -d
   ```

4. Open <http://localhost:8787> in two windows, continue as `ana` or `ben`, and
   draw. `?room=studio` opens the other room, which only `ana` may open.

The development sign-in page signs in anyone who picks a name, which is fine on
your own machine and nowhere else. The next section replaces it.

`docker compose logs -f gateway` shows the gateway, and
`docker compose ps` shows what is healthy. The canvas is ready once the
gateway is.

## Your own identity provider

The canvas signs people in with any OpenID Connect provider (Keycloak, Dex,
Entra ID, Okta, Auth0, Google and others), and Felix decides who may open which
room.

**At the provider**, register a single-page application (a public client):

| Setting | Value |
|---|---|
| Grant | Authorization code with PKCE (S256), no client secret |
| Redirect URI | The canvas's origin with a trailing slash, such as `https://canvas.example.com/` |
| Scopes | `openid profile`, plus whatever your subject claim needs, such as `email` |
| Allowed origins (CORS) | The canvas's origin. The page calls discovery and the token endpoint itself |

**In `.env`**, point the install at it and stop the development page:

```bash
COMPOSE_PROFILES=
CANVAS_OIDC_ISSUER=https://login.example.com/realms/canvas
CANVAS_OIDC_CLIENT_ID=felix-canvas
CANVAS_OIDC_SCOPES=openid profile email
CANVAS_OIDC_SUBJECT_CLAIM=email
CANVAS_OIDC_JWKS_URL=
CANVAS_ROOMS=lobby=ana@example.com,ben@example.com studio=ana@example.com
```

`CANVAS_OIDC_ISSUER` must match the ID token's `iss` exactly. Leave
`CANVAS_OIDC_JWKS_URL` empty when the seed and the control plane can reach the
issuer's discovery document; set it when they reach the provider at another
address than browsers do, as the Dex example below does.

Then `docker compose up -d`. The seed adds the provider to the tenant's
trusted issuers, with the client ID as the audience an ID token must carry.

Felix accepts only ES256 ID tokens unless told otherwise. The compose file sets
`FELIX_OIDC_ALGORITHMS=ES256,RS256`, which covers most providers.

**Who may open a room** is a Felix role per room, `role:room-<room>`. The seed
assigns it to each member listed in `CANVAS_ROOMS`: a value of the subject
claim, or `group:<name>` for everyone in a provider group when
`CANVAS_OIDC_GROUPS_CLAIM` names the claim your provider puts groups in.
Prefer a claim your provider keeps stable and unique: Dex's `sub`, for
example, is an opaque encoding, so the example uses `email`.

### Example: Dex

`deploy/compose/dex.yaml` adds [Dex](https://dexidp.io) with two local users,
`ana@example.com` and `ben@example.com`, password `password`. CI runs the
install this way on every pull request.

```bash
docker compose --env-file .env --env-file dex.env -f docker-compose.yml -f dex.yaml up -d
```

`dex.env` holds the settings above for Dex. Browsers reach Dex on
`127.0.0.1:5556`, and the control plane fetches its keys at `http://dex:5556`
on the compose network, which is why `CANVAS_OIDC_JWKS_URL` is set.

## Rooms and members

Add a room or a member to `CANVAS_ROOMS` and run `docker compose up -d`. The
seed runs at every start and creates whatever is missing; the snapshotter is
recreated with the new list.

The seed never removes anything. To take someone out of a room, delete their
assignment through the Felix control plane with an admin token, or remove the
room from `CANVAS_ROOMS` to stop snapshotting it. A removed member loses access
at their session's next token refresh.

Each room is two streams and three caches in Felix, one shard each:
`canvas.ops.<room>` (durable) and `canvas.presence.<room>` (in memory), and
`canvas.seq.<room>`, `canvas.snap.<room>` and `canvas.members.<room>`.
[design.md](design.md#authorization) explains why every room has its own.

## TLS

**Browsers to the canvas.** Serve the canvas over HTTPS anywhere but
`localhost`: the sign-in uses the browser's Web Crypto API, which only works
on secure origins. Put a reverse proxy in front of the gateway. With
[Caddy](https://caddyserver.com), which gets a certificate on its own, add a
`tls.yaml` next to the compose file:

```yaml
services:
  proxy:
    image: caddy:2
    command: caddy reverse-proxy --from canvas.example.com --to gateway:8787
    ports: ["80:80", "443:443"]
    volumes: [caddy-data:/data]
    restart: unless-stopped
volumes:
  caddy-data:
```

and start with `-f docker-compose.yml -f tls.yaml`. The proxy must pass
WebSocket upgrades on `/ws`, which Caddy does by default. Register
`https://canvas.example.com/` as the redirect URI.

**The gateway and snapshotter to the broker.** QUIC is always TLS. On first
start the `certs` service writes a self-signed certificate for the name
`broker` to the `state` volume, and both trust exactly that certificate. To use
your own, put `broker.crt` and `broker.key` (PEM) in the volume before the
first start; the certificate must name `broker`, and its issuer must be in the
certificate file you give the gateway and snapshotter.

**The control plane** is plain HTTP on the compose network, which nothing
outside reaches. So is the `tokens` provider, which is why
`FELIX_CONTROLPLANE_OIDC_ALLOW_INSECURE_HTTP` is on.

## Backups

Two volumes hold everything, and they belong together:

| Volume | What | Lose it and |
|---|---|---|
| `postgres-data` | The tenant, rooms, roles and trusted issuers | Felix no longer knows the rooms in its log |
| `felix-data` | Every room's op log, snapshots, member list and sequence counters | Every drawing is gone |
| `state` | The service tokens and the broker certificate | Nothing: the seed re-mints the tokens and `certs` makes a new certificate |

Back them up together, with the broker stopped so its log is not mid-write:

```bash
docker compose stop gateway snapshotter broker
docker compose exec postgres pg_dump -U felix felix > felix-metadata.sql
docker run --rm -v felix-canvas_felix-data:/data -v "$PWD":/backup debian:trixie-slim \
  tar czf /backup/felix-data.tar.gz -C /data .
docker compose up -d
```

To restore, start from empty volumes, load the dump into Postgres before the
control plane starts, untar the log into `felix-data`, and start the rest:

```bash
docker compose down -v
docker compose up -d --wait postgres
docker compose exec -T postgres psql -U felix felix < felix-metadata.sql
docker run --rm -v felix-canvas_felix-data:/data -v "$PWD":/backup debian:trixie-slim \
  tar xzf /backup/felix-data.tar.gz -C /data
docker compose up -d
```

A log restored without its metadata, or the other way round, does not match:
the broker would hold records for streams the control plane does not know.

## Upgrading

Each release pins its canvas images and the Felix version it was tested with
in `docker-compose.yml`. To upgrade, back up, replace `docker-compose.yml`
with the new release's, keep your `.env`, and restart:

```bash
docker compose pull
docker compose up -d
```

Read the release notes first for settings that were added or renamed, and
Felix's own release notes when `FELIX_VERSION` changes. Keep the backup until
the new release has run for a while: restoring it with the old compose file is
the way back.

The broker and snapshotter read their tokens once, when they start
([felix#955](https://github.com/gabloe/felix/issues/955)), and the tokens last
`FELIX_TOKEN_TTL_SECONDS`, 30 days by default. Restart at least that often,
which also re-mints them:

```bash
docker compose up -d --force-recreate
```

## Kubernetes

A Helm chart is on the way; until then, the compose install above is the
supported one.

## Configuration reference

### Compose (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `FELIX_BOOTSTRAP_TOKEN` | required | The control plane's day-0 token. The seed uses it to create the tenant |
| `POSTGRES_PASSWORD` | required | The control plane's database password |
| `CANVAS_BIND` | `127.0.0.1` | The host address the canvas listens on. `0.0.0.0` for every interface |
| `CANVAS_PORT` | `8787` | The host port the canvas listens on |
| `COMPOSE_PROFILES` | `dev-idp` | `dev-idp` runs the development sign-in page. Empty once you use your own provider |
| `CANVAS_DEV_USERS` | `ana,ben` | The names the development sign-in page offers |
| `CANVAS_OIDC_*`, `CANVAS_ROOMS` | the development page | As for the gateway and the seed below |
| `CANVAS_TENANT`, `CANVAS_NAMESPACE` | `canvas`, `default` | Where the rooms live in Felix |
| `CANVAS_VERSION` | the release | The canvas images' tag |
| `FELIX_VERSION` | the release's Felix | The Felix images' tag |
| `FELIX_OIDC_ALGORITHMS` | `ES256,RS256` | ID token signing algorithms Felix accepts |
| `FELIX_TOKEN_TTL_SECONDS` | `2592000` | How long a token from the control plane lasts, browser sessions' included. Sessions refresh theirs; the broker's and snapshotter's last until a restart |
| `FELIX_LOG`, `CANVAS_LOG` | `info` | Log filters for Felix and the gateway |

### Gateway

The gateway has no token of its own: each browser session gets one from the
control plane when it joins.

| Variable | Default | Meaning |
|---|---|---|
| `CANVAS_LISTEN` | `127.0.0.1:8787` (`0.0.0.0:8787` in the image) | Where browsers connect |
| `CANVAS_WEB_DIR` | unset (the bundle, in the image) | A built web bundle to serve on every other path |
| `CANVAS_FELIX_BROKERS` | `127.0.0.1:5000` | Comma-separated broker addresses, `host:port`. Names are resolved at each connection |
| `CANVAS_FELIX_SERVER_NAME` | `localhost` | The name the broker's certificate is checked against |
| `CANVAS_FELIX_CA_FILE` | the platform trust store | PEM certificates to trust for the broker |
| `CANVAS_FELIX_CONTROL_PLANE` | `http://127.0.0.1:8443` | The Felix control plane, where sign-ins are exchanged |
| `CANVAS_TENANT` | `canvas` | The Felix tenant |
| `CANVAS_NAMESPACE` | `default` | The Felix namespace the rooms live in |
| `CANVAS_OIDC_ISSUER` | `http://127.0.0.1:9400` | The identity provider browsers sign in with, as its issuer URL |
| `CANVAS_OIDC_CLIENT_ID` | `felix-canvas` | The client registered for the canvas at that provider |
| `CANVAS_OIDC_SCOPES` | `openid profile` | The scopes a browser asks the provider for |
| `CANVAS_MEMBER_TTL_SECONDS` | `30` | How long a member entry outlives its last refresh |
| `RUST_LOG` | `info` | Log filter |

### Snapshotter

It reads `CANVAS_FELIX_BROKERS`, `CANVAS_FELIX_SERVER_NAME`,
`CANVAS_FELIX_CA_FILE`, `CANVAS_TENANT` and `CANVAS_NAMESPACE` as the gateway
does, and:

| Variable | Default | Meaning |
|---|---|---|
| `CANVAS_FELIX_TOKEN` | required, or the file | Its own Felix token |
| `CANVAS_FELIX_TOKEN_FILE` | unset | A file holding that token, read at start |
| `CANVAS_ROOMS` | `lobby` | The rooms to snapshot, in the seed's format; only the names before `=` are read |
| `CANVAS_SNAPSHOTTER_LISTEN` | `127.0.0.1:8788` (`0.0.0.0:8788` in the image) | Where it answers `GET /` with each room's `{"applied", "saved"}`: the last offset folded and the last one a stored snapshot holds |
| `CANVAS_SNAPSHOT_EVERY_OPS` | `500` | Write a room's snapshot once this many records are folded but not saved |
| `CANVAS_SNAPSHOT_EVERY_MS` | `30000` | Or once the oldest of them has waited this long |
| `CANVAS_SNAPSHOTTER_CLAIM_WAIT_MS` | `30000` | How long it waits after starting before it reads, so records an earlier run claimed come back first. Match the broker's `FELIX_GROUP_VISIBILITY_TIMEOUT_MS` |

One snapshotter runs per deployment. Two would split each room's records
between them and write wrong snapshots.

### Seed

`node dev/seed.mjs` in the snapshotter image. Safe to run again.

| Variable | Default | Meaning |
|---|---|---|
| `CANVAS_FELIX_CONTROL_PLANE` | `http://controlplane:8443` | The control plane's API |
| `CANVAS_FELIX_BOOTSTRAP` | `http://controlplane:9095` | The control plane's bootstrap listener |
| `CANVAS_FELIX_BOOTSTRAP_TOKEN` | `dev-bootstrap` | Its token |
| `CANVAS_SERVICE_IDP` | `http://idp:9400` | A `dev/idp.mjs` the service accounts sign in with. Keep it unreachable from outside |
| `CANVAS_STATE_DIR` | `/state` | Where it writes `node.token` and `snapshotter.token` |
| `CANVAS_TENANT`, `CANVAS_NAMESPACE` | `canvas`, `default` | Where to create the rooms |
| `CANVAS_ROOMS` | `lobby=ana,ben studio=ana` | Rooms and their members, `room=member,member` separated by spaces |
| `CANVAS_OIDC_ISSUER` | the service provider's | The browsers' provider |
| `CANVAS_OIDC_JWKS_URL` | from the issuer's discovery document | Where Felix fetches that provider's keys |
| `CANVAS_OIDC_CLIENT_ID` | `felix-canvas` | The client ID, used as the audience unless the next one is set |
| `CANVAS_OIDC_AUDIENCE` | the client ID | The audience browsers' ID tokens carry |
| `CANVAS_OIDC_SUBJECT_CLAIM` | `sub` | The claim that names a member |
| `CANVAS_OIDC_GROUPS_CLAIM` | unset | The claim holding a member's groups, for `group:` members |

## Felix gaps this works around

| What | Why | Felix issue |
|---|---|---|
| The `tokens` service | Felix issues tokens only in exchange for an IdP token, so the service accounts need a provider of their own | [#954](https://github.com/gabloe/felix/issues/954) |
| `FELIX_TOKEN_TTL_SECONDS` of 30 days and a restart within it | A standalone broker reads its token once and stops working when it expires | [#955](https://github.com/gabloe/felix/issues/955) |
| `FELIX_ACK_ON_COMMIT=true` on the broker | Only an ack after the write carries the record's offset, and that is a broker-wide setting | [#956](https://github.com/gabloe/felix/issues/956) |
| The compose file is written from Felix's environment reference | Felix's own compose docs still pin 0.5.0 | [#957](https://github.com/gabloe/felix/issues/957) |
