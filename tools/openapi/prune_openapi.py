#!/usr/bin/env python3
"""
Prune an OpenAPI 3.x JSON spec down to a smaller subset (paths + referenced components).

Why:
- GAAB MCP "Gateway -> OpenAPI" schema upload is capped at 2MB.
- GitHub's full OpenAPI dereferenced JSON is ~10MB+.

This script:
- keeps only selected path prefixes (or regexes),
- strips large text fields (description/summary/examples/etc),
- keeps only referenced components under #/components/*.

Usage examples:

  # Recommended preset for GAAB MCP "GitHub tooling" (GHES 3.9+):
  # - Actions
  # - Issues
  # - Pull requests
  # - Merge queues
  # - Webhooks
  #
  # Input file (per your machine): ~/Downloads/ghes-3.9.json
  python3 tools/openapi/prune_openapi.py \
    --in /Users/robinsonaizprua/Downloads/ghes-3.9.json \
    --out github-mcp-devops.json \
    --preset github-devops

  # Or use regex (Python re)
  python3 tools/openapi/prune_openapi.py \
    --in api.github.com.json \
    --out github-mcp-issues.json \
    --include-regex '^/repos/[^/]+/[^/]+/issues'
"""

from __future__ import annotations

import argparse
import json
import os
import re
from copy import deepcopy
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple


def _load_json(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _dump_json(obj: Any, path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2, sort_keys=False)


def _iter_refs(node: Any) -> Iterable[str]:
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str):
            yield ref
        for v in node.values():
            yield from _iter_refs(v)
    elif isinstance(node, list):
        for v in node:
            yield from _iter_refs(v)


def _parse_component_ref(ref: str) -> Optional[Tuple[str, str]]:
    # #/components/{type}/{name}
    if not ref.startswith("#/components/"):
        return None
    parts = ref.split("/")
    if len(parts) < 4:
        return None
    comp_type = parts[2]
    comp_name = "/".join(parts[3:])
    return comp_type, comp_name


STRIP_KEYS = {
    "description",
    "summary",
    "externalDocs",
    "examples",
    "example",
    "x-codeSamples",
    "x-codegen-request-body-name",
    "x-github",
    "x-github-enterprise",
    "x-githubCloudOnly",
    "x-githubEnterpriseOnly",
    "x-githubInternal",
    "x-github-internal",
    "x-github-beta",
    "x-github-preview",
    "x-githubApiVersion",
    "x-githubApiVersionIntroduced",
    "x-githubApiVersionDeprecated",
    "x-githubApiVersionRemoved",
    "x-github-deprecation-date",
    "x-github-package",
    "x-github-redirect-url",
    "x-github-metadata",
    "x-logo",
    "x-tagGroups",
}


def _strip_big_fields(node: Any) -> Any:
    if isinstance(node, dict):
        out: Dict[str, Any] = {}
        for k, v in node.items():
            if k in STRIP_KEYS:
                continue
            # Drop vendor extensions by default (huge), except a few that are useful.
            if k.startswith("x-") and k not in {"x-amazon-apigateway-integration"}:
                continue
            out[k] = _strip_big_fields(v)
        return out
    if isinstance(node, list):
        return [_strip_big_fields(v) for v in node]
    return node


def _match_path(path: str, prefixes: List[str], regexes: List[re.Pattern[str]]) -> bool:
    if any(path.startswith(p) for p in prefixes):
        return True
    return any(r.search(path) for r in regexes)


def prune_openapi(
    spec: Dict[str, Any],
    *,
    include_prefixes: List[str],
    include_regexes: List[re.Pattern[str]],
) -> Dict[str, Any]:
    spec = deepcopy(spec)

    paths: Dict[str, Any] = spec.get("paths") or {}
    kept_paths: Dict[str, Any] = {}
    for p, item in paths.items():
        if _match_path(p, include_prefixes, include_regexes):
            kept_paths[p] = item

    # Minimal skeleton
    out: Dict[str, Any] = {
        "openapi": spec.get("openapi", "3.0.0"),
        "info": spec.get("info") or {"title": "Pruned API", "version": "0.0.0"},
        "servers": spec.get("servers") or [],
        "paths": kept_paths,
        "components": spec.get("components") or {},
    }

    # Strip big fields first (reduces traversal size)
    out = _strip_big_fields(out)

    # Collect referenced components from kept paths + (later) from components themselves
    needed: Set[Tuple[str, str]] = set()
    queue: List[Tuple[str, str]] = []

    def add_ref(ref: str) -> None:
        parsed = _parse_component_ref(ref)
        if not parsed:
            return
        if parsed not in needed:
            needed.add(parsed)
            queue.append(parsed)

    for ref in _iter_refs(out.get("paths")):
        add_ref(ref)

    comps: Dict[str, Any] = out.get("components") or {}

    # Walk referenced components transitively
    while queue:
        comp_type, comp_name = queue.pop()
        comp_bucket = comps.get(comp_type) or {}
        comp_obj = comp_bucket.get(comp_name)
        if comp_obj is None:
            continue
        for ref in _iter_refs(comp_obj):
            add_ref(ref)

    # Rebuild components with only referenced members
    new_components: Dict[str, Any] = {}
    for comp_type, comp_name in sorted(needed):
        bucket = comps.get(comp_type) or {}
        if comp_name in bucket:
            new_components.setdefault(comp_type, {})[comp_name] = bucket[comp_name]

    out["components"] = _strip_big_fields(new_components)
    return out


PRESETS: Dict[str, Dict[str, List[str]]] = {
    # GitHub "DevOps" toolset subset:
    # - issues + issue comments
    # - pull requests + review comments
    # - actions
    # - merge queues (newer API surface; keep broad)
    # - webhooks (repo hooks)
    #
    # NOTE: We use regexes rather than /repos/ prefix to avoid pulling the entire GitHub surface area.
    "github-devops": {
        "include_prefix": [],
        "include_regex": [
            r"^/repos/[^/]+/[^/]+/issues($|/)",
            r"^/repos/[^/]+/[^/]+/pulls($|/)",
            r"^/repos/[^/]+/[^/]+/actions($|/)",
            r"^/repos/[^/]+/[^/]+/merge-queues($|/)",
            r"^/repos/[^/]+/[^/]+/hooks($|/)",
        ],
    }
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_path", required=True, help="Input OpenAPI JSON file")
    ap.add_argument("--out", dest="out_path", required=True, help="Output OpenAPI JSON file")
    ap.add_argument(
        "--preset",
        choices=sorted(PRESETS.keys()),
        help="Built-in pruning preset (recommended for GitHub specs to stay under GAAB's 2MB limit).",
    )
    ap.add_argument("--include-prefix", action="append", default=[], help="Keep paths starting with this prefix")
    ap.add_argument("--include-regex", action="append", default=[], help="Keep paths matching this regex (Python re)")
    args = ap.parse_args()

    prefixes: List[str] = list(args.include_prefix or [])
    regex_strs: List[str] = list(args.include_regex or [])

    if args.preset:
        preset = PRESETS[args.preset]
        prefixes = list(preset.get("include_prefix", [])) + prefixes
        regex_strs = list(preset.get("include_regex", [])) + regex_strs

    regexes: List[re.Pattern[str]] = [re.compile(r) for r in regex_strs]
    if not prefixes and not regexes:
        raise SystemExit("Provide at least one --preset, --include-prefix, or --include-regex.")

    spec = _load_json(args.in_path)
    pruned = prune_openapi(spec, include_prefixes=prefixes, include_regexes=regexes)
    _dump_json(pruned, args.out_path)

    size = os.path.getsize(args.out_path)
    print(f"Wrote {args.out_path} ({size/1024/1024:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


