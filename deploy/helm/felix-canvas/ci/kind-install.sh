#!/usr/bin/env bash
# Install Felix and this chart on the current kind cluster, as CI does. The
# canvas images must be loaded into the cluster as :ci, and FELIX_CHART must
# be the felix chart (deploy/helm/felix in the Felix repository).
set -euo pipefail
cd "$(dirname "$0")"
: "${FELIX_CHART:?set FELIX_CHART to the felix chart directory}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
kubectl create secret generic felix-bootstrap --from-literal=token="$(openssl rand -hex 24)"
kubectl create secret generic felix-raft-peer --from-literal=token="$(openssl rand -hex 24)"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
  -subj /CN=felix-broker -addext subjectAltName=DNS:felix-broker \
  -addext basicConstraints=critical,CA:FALSE -addext extendedKeyUsage=serverAuth \
  -keyout "$tmp/tls.key" -out "$tmp/tls.crt" 2>/dev/null
kubectl create secret tls felix-broker-tls --cert="$tmp/tls.crt" --key="$tmp/tls.key"

# The brokers need the credential the seed mints, so they come last.
helm install felix "$FELIX_CHART" -f felix-values.yaml --wait --timeout 8m
helm install felix-canvas .. -f kind-values.yaml
kubectl wait --for=condition=complete job -l app.kubernetes.io/component=seed --timeout 5m
helm upgrade felix "$FELIX_CHART" -f felix-values.yaml --set broker.enabled=true --wait --timeout 10m
kubectl rollout status deployment/felix-canvas-gateway --timeout 5m
kubectl rollout status deployment/felix-canvas-snapshotter --timeout 5m
