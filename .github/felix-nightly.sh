#!/usr/bin/env bash
# The nightly run against Felix main: starts the dev stack from the Felix images
# tagged $FELIX_IMAGE_TAG (default: nightly) and runs the checks that CI runs
# against it. The felix-nightly workflow calls this after installing the
# TypeScript client built from the same Felix commit, so the snapshotter runs
# on that client; the released gateway is the one CI uses.
#
# It rewrites the image tags in the compose files, so run it from a throwaway
# checkout.
set -euo pipefail
cd "$(dirname "$0")/.."

tag=${FELIX_IMAGE_TAG:-nightly}
images=(dev/docker-compose.yml)
TAG=$tag perl -pi -e 's{(ghcr\.io/getfelix/felix-(?:broker|controlplane)):[^\s"\x27]+}{$1:$ENV{TAG}}' "${images[@]}"
# A pattern that stopped matching would leave the pinned release running.
if ! grep -hq "ghcr\.io/getfelix/felix-broker:$tag" "${images[@]}" ||
  grep -h 'ghcr\.io/getfelix/felix-\(broker\|controlplane\)' "${images[@]}" | grep -qv ":${tag}[[:space:]]*\$"; then
  echo "the compose files do not all use the $tag images" >&2
  exit 1
fi

logs() {
  [ $? -eq 0 ] || docker compose -f dev/docker-compose.yml -f dev/docker-compose.cluster.yml logs --no-color
}
trap logs EXIT

echo "::group::Gateway against Felix"
gateway_version=$(sed -n 's/^ *default: *//p' .github/actions/felix-gateway/action.yml | head -n1)
cargo install --locked felix-gateway --version "$gateway_version"
dev/up.sh
GATEWAY_FELIX_CA_FILE="$PWD/dev/state/broker-cert.pem" \
GATEWAY_SCOPE_FILE="$PWD/deploy/scope.toml" \
GATEWAY_TENANT=canvas \
GATEWAY_OIDC_CLIENT_ID=felix-canvas \
  felix-gateway >"${RUNNER_TEMP:-/tmp}/gateway.log" 2>&1 &
gateway=$!
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8787/oidc && curl -fsS http://127.0.0.1:8787/metrics && break
  sleep 1
done
node .github/scripts/gateway-join.mjs || { cat "${RUNNER_TEMP:-/tmp}/gateway.log"; exit 1; }
kill "$gateway"
echo "::endgroup::"

echo "::group::Two browsers against Felix"
npm run build -w @felix-canvas/model
# Playwright's web server would build this too, but it hides tsc's output, so a
# break against the client from Felix main would show only as "build failed".
npm run build -w @felix-canvas/snapshotter
npx -w @felix-canvas/web playwright install --with-deps chromium
dev/up.sh
npm run test:e2e -w @felix-canvas/web
echo "::endgroup::"

echo "::group::Failover against a Felix cluster"
dev/up.sh --cluster
CANVAS_FELIX_CLUSTER=1 \
CANVAS_FELIX_BROKERS=127.0.0.1:5000,127.0.0.1:5010,127.0.0.1:5020 \
  npm run test:e2e -w @felix-canvas/web -- failover
echo "::endgroup::"
