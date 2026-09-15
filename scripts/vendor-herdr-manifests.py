#!/usr/bin/env python3
"""Re-vendor Herdr's agent-detection manifests as JSON.

Herdr (https://github.com/herdrdev/herdr, Apache-2.0) publishes per-runtime screen rules as TOML
under distribution/agent-detection/. aify-env evaluates the same rules against its own headless
screen, so it carries them as JSON -- Node has no TOML parser and this adds no dependency.

    python3 scripts/vendor-herdr-manifests.py                 # fetch at the pinned tag
    python3 scripts/vendor-herdr-manifests.py --tag v0.9.1    # fetch another tag
    python3 scripts/vendor-herdr-manifests.py --from DIR      # convert a local checkout's TOML

The JSON is the TOML parsed by tomllib and written unchanged, plus a `vendored` block naming the
upstream path, tag, commit and the sha256 of the exact TOML bytes, so a reader can check the copy
against upstream without trusting this script.
"""
import argparse
import hashlib
import json
import pathlib
import sys
import tomllib
import urllib.request

REPO = "herdrdev/herdr"
TAG = "v0.9.0"
UPSTREAM_DIR = "distribution/agent-detection"
RUNTIMES = ("claude", "codex", "hermes")
OUT = pathlib.Path(__file__).resolve().parent.parent / "lib" / "plugins" / "aify-comms" / "agent-detection"


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()


def commit_for(tag: str) -> str:
    ref = json.loads(fetch(f"https://api.github.com/repos/{REPO}/commits/{tag}"))
    return ref["sha"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", default=TAG)
    parser.add_argument("--from", dest="source", help="a local Herdr checkout to read instead of fetching")
    parser.add_argument("--commit", help="the commit the local checkout is at (required with --from)")
    args = parser.parse_args()
    if args.source and not args.commit:
        parser.error("--from needs --commit, so the provenance names what was converted")

    commit = args.commit or commit_for(args.tag)
    OUT.mkdir(parents=True, exist_ok=True)
    for runtime in RUNTIMES:
        path = f"{UPSTREAM_DIR}/{runtime}.toml"
        if args.source:
            raw = (pathlib.Path(args.source) / path).read_bytes()
        else:
            raw = fetch(f"https://raw.githubusercontent.com/{REPO}/{commit}/{path}")
        manifest = tomllib.loads(raw.decode("utf-8"))
        if manifest.get("id") != runtime:
            print(f"{path}: id is {manifest.get('id')!r}, expected {runtime!r}", file=sys.stderr)
            return 1
        manifest["vendored"] = {
            "from": f"https://github.com/{REPO}/blob/{args.tag}/{path}",
            "tag": args.tag,
            "commit": commit,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "license": "Apache-2.0",
        }
        target = OUT / f"{runtime}.json"
        target.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"{target.name}: {len(manifest['rules'])} rules, sha256 {manifest['vendored']['sha256']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
