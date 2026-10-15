#!/usr/bin/env python3
"""Audit every tracked Markdown file structurally; reference docs are warnings.

This does not certify semantic accuracy or implemented/runtime behavior.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
LINK = re.compile(r"!?\[[^\]]*\]\(([^\n)]*)\)")
CONFLICT = re.compile(r"^(?:<{7}|={7}|>{7})(?:\s|$)")
HTML_LINK = re.compile(r'\b(?:src|href)\s*=\s*["\']([^"\']+)["\']', re.I)
REF_DEF = re.compile(r'^\s{0,3}\[(?!\^)[^\]]+\]:\s*(?:<([^>]+)>|(\S+))')
NUMBERED_HEADING = re.compile(r'^#{2,6}\s+(\d+\.\d+(?:\.\d+)*)(?:\s|$)')
HEADING = re.compile(r"^#{2,4}\s+(\d+\.\d+)(?!\d)")
REFERENCE = re.compile(r"§{1,2}\s*(\d{1,2}\.\d{1,2})(?!\d)")
CURRENT_PLAN = "docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md"
HISTORICAL_GAPS = {"14.11","14.12","14.13","14.14","20.9","31.18","32.30"}
KNOWN_OWNER = {"1","2","3","4","5","10","11","12","13","14","15","16","17","18","20","21","29","30","31","32","33","37","42"}

def scope(path: str) -> str:
    if path.startswith("opencode/"): return "upstream"
    if path.startswith(("docs/architecture-archive/","docs/architecture-input/")): return "historical"
    if path.startswith("docs/superpowers/") and path != CURRENT_PLAN: return "superseded-plan"
    return "active-or-entrypoint"

def target(raw: str) -> str | None:
    raw = raw.strip()
    if raw.startswith("<"): raw = raw.split(">", 1)[0][1:]
    elif ' "' in raw: raw = raw.split(' "', 1)[0]
    elif " '" in raw: raw = raw.split(" '", 1)[0]
    if not raw or raw.startswith(("#","/","//","{","<")): return None
    if raw.lower().startswith(("http:","https:","mailto:","data:","file:","javascript:","tel:")): return None
    return unquote(urlsplit(raw).path) or None

def run() -> dict:
    indexed = subprocess.check_output(["git","ls-files","-z"], cwd=ROOT)
    tracked = {v.decode("utf-8","surrogateescape") for v in indexed.split(b"\0") if v}
    markdown = sorted(p for p in tracked if p.lower().endswith(".md"))
    headings = set()
    for p in markdown:
        if p.startswith("arch_V1/") and p.count("/") == 1:
            headings.update(m.group(1) for line in (ROOT/p).read_text(encoding="utf-8").splitlines() if (m:=HEADING.match(line)))
    results = []
    for p in markdown:
        data = (ROOT/p).read_bytes()
        lines = data.decode("utf-8", "replace").splitlines()
        issues, fence, numbered = [], None, set()
        try: data.decode("utf-8")
        except UnicodeDecodeError: issues.append({"line":1,"kind":"invalid-utf8"})
        for n,line in enumerate(lines,1):
            fm = FENCE.match(line)
            if fm:
                token = fm.group(1)
                if fence is None: fence = (token[0],len(token),n)
                elif token[0] == fence[0] and len(token) >= fence[1]: fence = None
                continue
            if fence is not None: continue
            if scope(p) == "active-or-entrypoint":
                heading = NUMBERED_HEADING.match(line)
                if heading:
                    sid = heading.group(1)
                    if sid in numbered:
                        issues.append({"line":n,"kind":"duplicate-numbered-heading","section":sid})
                    numbered.add(sid)
            if CONFLICT.match(line): issues.append({"line":n,"kind":"conflict-marker"})
            destinations = ([m.group(1) for m in LINK.finditer(line)]
                + [m.group(1) for m in HTML_LINK.finditer(line)]
                + [m.group(1) or m.group(2) for m in REF_DEF.finditer(line)])
            for destination in destinations:
                u = target(destination)
                if u is None: continue
                resolved = ((ROOT/p).parent/u).resolve(strict=False)
                try: rel = resolved.relative_to(ROOT).as_posix()
                except ValueError:
                    issues.append({"line":n,"kind":"link-escapes-repository","target":u})
                    continue
                if rel not in tracked and not any(f.startswith(rel+"/") for f in tracked):
                    issues.append({"line":n,"kind":"missing-relative-link","target":u})
            if scope(p) == "active-or-entrypoint":
                for m in REFERENCE.finditer(line):
                    section = m.group(1)
                    if section in HISTORICAL_GAPS and any(word in line.lower() for word in ("broken","dangling","nonexistent","unallocated","retired")): continue
                    if section.split(".")[0] in KNOWN_OWNER and section not in headings:
                        issues.append({"line":n,"kind":"missing-architecture-section","section":section})
        if fence is not None: issues.append({"line":fence[2],"kind":"unclosed-fence"})
        results.append({"path":p,"scope":scope(p),"sha256":hashlib.sha256(data).hexdigest(),"bytes":len(data),"lines":len(lines),"issues":issues})
    blockers = [{"path":f["path"],**i} for f in results if f["scope"] == "active-or-entrypoint" for i in f["issues"]]
    warnings = [{"path":f["path"],**i} for f in results if f["scope"] != "active-or-entrypoint" for i in f["issues"]]
    return {"structural_only":True,"tracked_markdown":len(markdown),"lines":sum(f["lines"] for f in results),"bytes":sum(f["bytes"] for f in results),"files":results,"active_blockers":blockers,"reference_warnings":warnings}

def main() -> int:
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--json-report",type=Path)
    args=p.parse_args()
    outcome=run()
    if args.json_report:
        args.json_report.parent.mkdir(parents=True,exist_ok=True)
        args.json_report.write_text(json.dumps(outcome,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
    print("TRACKED_MARKDOWN",outcome["tracked_markdown"],"LINES",outcome["lines"],"BYTES",outcome["bytes"])
    print("ACTIVE_BLOCKERS",len(outcome["active_blockers"]),"REFERENCE_WARNINGS",len(outcome["reference_warnings"]))
    for issue in outcome["active_blockers"][:80]: print("FAIL",json.dumps(issue))
    for issue in outcome["reference_warnings"][:15]: print("REFERENCE_ONLY",json.dumps(issue))
    return 1 if outcome["active_blockers"] else 0

if __name__ == "__main__": sys.exit(main())
