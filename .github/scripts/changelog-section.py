#!/usr/bin/env python3
"""Print one version's section of CHANGELOG.md, for the release notes.

Usage: changelog-section.py v0.2.0

Fails when the section is missing or empty, so a release whose changelog entry
was forgotten stops before it publishes.
"""

import re
import sys
from pathlib import Path

CHANGELOG = Path(__file__).resolve().parents[2] / "CHANGELOG.md"


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: changelog-section.py <tag>", file=sys.stderr)
        return 2
    version = sys.argv[1].removeprefix("v")
    text = CHANGELOG.read_text(encoding="utf-8")
    # Headings look like `## [0.1.0] - 2026-10-03`; the section runs to the next `## `.
    found = re.search(rf"^## \[{re.escape(version)}\][^\n]*\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    body = found.group(1).strip() if found else ""
    if not body:
        print(f"CHANGELOG.md has no section for {version}, or it is empty", file=sys.stderr)
        return 1
    print(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
