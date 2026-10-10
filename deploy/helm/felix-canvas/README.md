# felix-canvas

Felix Canvas on Kubernetes, installed next to a release of the
[felix chart](https://github.com/GetFelix/felix/tree/main/deploy/helm/felix).

| Component | Shape | Why |
| --- | --- | --- |
| Gateway | Deployment, 2 replicas by default, Service, optional Ingress | It holds no state, so any replica serves any room and no session affinity is needed |
| Snapshotter | Deployment of exactly one, `Recreate` | Two would split each room's records between them and write wrong snapshots |
| Seed | A Job per revision, with a Role that may write two Secrets | Creates the tenant, rooms and roles at every install and upgrade, and stores the broker credential and the snapshotter's token |
| `tokens` | Deployment and ClusterIP Service | Signs in the seed's service accounts, because Felix issues tokens only in exchange for an IdP token ([felix#954](https://github.com/GetFelix/felix/issues/954)) |
| `idp` | Deployment and Service, only with `devIdp.enabled` | The development sign-in page, for trying the chart out |
| Rooms service | Deployment of exactly one, `Recreate`, Service, a Secret with the invite key, and `/api` on the ingress, only with `selfService.enabled` | Lets signed-in people create rooms and invite others. It is the only writer of the room list |

[docs/self-hosting.md](../../../docs/self-hosting.md#kubernetes) has the
install sequence, which interleaves this chart with the felix chart because
the brokers need the credential the seed mints. `ci/` holds the values CI
installs both charts with on kind, and `ci/kind-install.sh` is that sequence
as a script.

## Values

`values.yaml` documents each one. The ones an install must set:

| Value | Meaning |
| --- | --- |
| `felix.controlPlaneUrl` | The Felix control plane's API, e.g. `http://felix-controlplane:8443` |
| `felix.brokers` | Broker addresses as `host:port`, e.g. `[felix-broker:5000]` |
| `felix.serverName`, `felix.caSecret` | The name on the brokers' client certificate, and a Secret with the PEM to trust it by |
| `seed.bootstrapUrl`, `seed.bootstrapSecret` | The control plane's bootstrap listener and a Secret with its token |
| `oidc.issuer`, `oidc.clientId` | Your identity provider, unless `devIdp.enabled` |
| `rooms` | Rooms and their members, `room=member,member` separated by spaces |
| `gateway.ingress` | The host browsers use, with a TLS Secret: signing in needs HTTPS |
