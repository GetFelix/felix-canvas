#!/usr/bin/env bash
# Save each Felix container's log, stopped or killed ones included, to
# felix-logs.tar.gz in the current directory.
# Docker or Podman, picked as dev/up.sh picks it.
set -uo pipefail

engine="${CONTAINER_ENGINE:-}"
if [[ -z "$engine" ]]; then
  if docker info >/dev/null 2>&1; then engine=docker; else engine=podman; fi
fi

out="$(mktemp -d)/felix-logs"
mkdir -p "$out"
for name in $("$engine" ps --all --filter label=com.docker.compose.project=felix-canvas --format '{{.Names}}'); do
  "$engine" logs --timestamps "$name" >"$out/$name.log" 2>&1
  "$engine" inspect "$name" >"$out/$name.inspect.json" 2>&1
done
tar -czf felix-logs.tar.gz -C "$(dirname "$out")" felix-logs
ls -l "$out"
