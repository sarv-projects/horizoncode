import json, pathlib, re, sys, urllib.request
HERE = pathlib.Path("/home/sarvesh/business_Dev/agentx/scripts/e2e/nemotron-bench")
BRIEF = pathlib.Path("/mnt/c/Users/Sonali/Downloads/horizoncode_nemotron_coding_tasks.md")
OUT = HERE / "tasks.json"
URLS = [
 "https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified/resolve/main/data/test-00000-of-00001.parquet",
 "https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified/resolve/main/data/test-00000-of-00001.parquet",
]
text = BRIEF.read_text(encoding="utf-8", errors="replace")
ids = []
for m in re.findall(r"`([a-z.-]+__[A-Za-z0-9_.-]+)`", text):
    if m not in ids: ids.append(m)
print("brief ids:", len(ids), ids)
parquet = HERE / ".swebench-verified.parquet"
if not parquet.exists():
    ok = False
    for u in URLS:
        try:
            print("fetch", u)
            with urllib.request.urlopen(u, timeout=180) as r, parquet.open("wb") as f:
                f.write(r.read())
            ok = parquet.stat().st_size > 1024
            if ok: break
        except Exception as e:
            print("  failed:", e)
    if not ok: sys.exit("download failed")
import pandas as pd
df = pd.read_parquet(parquet)
rows = df[df["instance_id"].isin(ids)]
found = set(rows["instance_id"].tolist())
tasks = []
for _, r in rows.iterrows():
    f2p = r["FAIL_TO_PASS"]; p2p = r["PASS_TO_PASS"]
    tasks.append({
        "instance_id": r["instance_id"], "repo": r["repo"], "base_commit": r["base_commit"],
        "version": str(r.get("version","")), "environment_setup_commit": str(r.get("environment_setup_commit","")),
        "problem_statement": r["problem_statement"], "hints_text": str(r.get("hints_text","")),
        "test_patch": r["test_patch"],
        "FAIL_TO_PASS": json.loads(f2p) if isinstance(f2p,str) else list(f2p),
        "PASS_TO_PASS": json.loads(p2p) if isinstance(p2p,str) else list(p2p),
        "gold_patch": r["patch"],
    })
tasks.sort(key=lambda t: ids.index(t["instance_id"]))
OUT.write_text(json.dumps(tasks, indent=2) + "\n", encoding="utf-8")
print("wrote", len(tasks), "tasks ->", OUT)
missing = [i for i in ids if i not in found]
if missing: print("MISSING:", missing)