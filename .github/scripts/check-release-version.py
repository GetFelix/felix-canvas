#!/usr/bin/env python3
"""Check that every version in the tree matches a release tag.

Usage: check-release-version.py v0.2.0, from the root of the tree to check.

The images are tagged from the git tag, the chart and the packages from their
own files, and the install from the compose defaults, so a missed bump ships a
release whose parts name different versions. This runs before anything is
published, and on every pull request against the tree's own version.
"""

import json
import re
import sys
from pathlib import Path

# The tree being released: the working directory, which need not be the
# checkout this script came from.
REPO = Path.cwd()

VERSION = r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*?)?"
# Ends a version, so a lazy pre-release suffix is not cut short.
END = r"(?![0-9A-Za-z.-])"

# Places the docs name a released version: image and chart references, the
# release download links and the compose bundle's name.
DOC_PINS = [
    re.compile(rf"ghcr\.io/getfelix/(?:charts/)?felix-canvas[a-z-]*:({VERSION}){END}"),
    re.compile(rf"releases/download/v({VERSION})/"),
    re.compile(rf"felix-canvas-compose-({VERSION})(?:\.tar\.gz|{END})"),
    re.compile(rf"felix-canvas-({VERSION})\.tgz"),
    re.compile(rf"oci://ghcr\.io/getfelix/charts/felix-canvas --version ({VERSION}){END}"),
]
DOC_FILES = ["README.md", "deploy/helm/felix-canvas/README.md", *sorted(
    str(p.relative_to(REPO)) for p in (REPO / "docs").rglob("*.md"))]


def found_versions() -> list[tuple[str, str | None]]:
    def text(path: str) -> str:
        return (REPO / path).read_text(encoding="utf-8")

    def first(pattern: str, path: str) -> str | None:
        match = re.search(pattern, text(path), re.M)
        return match.group(1) if match else None

    out: list[tuple[str, str | None]] = []
    out.append(("gateway/Cargo.toml", first(r'^version\s*=\s*"([^"]+)"', "gateway/Cargo.toml")))
    out.append(("Cargo.lock felix-canvas-gateway",
                first(r'^name = "felix-canvas-gateway"\nversion = "([^"]+)"', "Cargo.lock")))

    lock = json.loads(text("package-lock.json"))["packages"]
    for pkg in ["model", "web", "snapshotter"]:
        out.append((f"{pkg}/package.json", json.loads(text(f"{pkg}/package.json")).get("version")))
        out.append((f"package-lock.json {pkg}", lock.get(pkg, {}).get("version")))

    chart = "deploy/helm/felix-canvas/Chart.yaml"
    out.append((f"{chart} version", first(r'^version:\s*"?([^"\s]+)"?', chart)))
    out.append((f"{chart} appVersion", first(r'^appVersion:\s*"?([^"\s]+)"?', chart)))

    for path in sorted((REPO / "deploy/compose").glob("*.y*ml")):
        rel = str(path.relative_to(REPO))
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for match in re.finditer(r"\$\{CANVAS_VERSION:-([^}]*)\}", line):
                out.append((f"{rel}:{number} CANVAS_VERSION default", match.group(1)))

    for rel in DOC_FILES:
        for number, line in enumerate(text(rel).splitlines(), 1):
            for pattern in DOC_PINS:
                for match in pattern.finditer(line):
                    out.append((f"{rel}:{number} {match.group(0)}", match.group(1)))
    return out


def main() -> int:
    if len(sys.argv) != 2 or not re.fullmatch(rf"v{VERSION}", sys.argv[1]):
        print("usage: check-release-version.py v<major>.<minor>.<patch>[-<pre>]", file=sys.stderr)
        return 2
    expected = sys.argv[1][1:]

    versions = found_versions()
    if not any("CANVAS_VERSION" in where for where, _ in versions):
        print("FAIL deploy/compose: no ${CANVAS_VERSION:-...} default found")
        return 1

    bad = 0
    for where, version in versions:
        if version == expected:
            print(f"ok   {where}: {version}")
        else:
            print(f"FAIL {where}: {version}, expected {expected}")
            bad += 1
    if bad:
        print(f"{bad} version(s) do not match {sys.argv[1]}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
