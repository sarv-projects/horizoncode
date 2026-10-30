#!/usr/bin/env bash
# Rescue: make workspace package names match the dependency graph the source
# actually imports. A fresh clone cannot `bun install` because every workspace
# dep is written as @opencode-ai/* while some package.json `name` fields were
# renamed to @horizoncode/*.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "=== package.json name fields"
grep -h '"name":' packages/*/package.json packages/*/*/package.json 2>/dev/null \
  | sed 's/.*"name": *"\([^"]*\)".*/\1/' | cut -d/ -f1 | sort | uniq -c | sort -rn | head

echo "=== dependency specifiers mentioning either scope"
grep -rho '"@\(opencode-ai\|horizoncode\)/[^"]*"' packages/*/package.json packages/*/*/package.json 2>/dev/null \
  | cut -d/ -f1 | sort | uniq -c

echo "=== source imports"
grep -rho '@\(opencode-ai\|horizoncode\)/' packages --include=*.ts 2>/dev/null | sort | uniq -c

echo "=== files whose package.json name is scoped @horizoncode"
grep -rl '"name": *"@horizoncode/' packages/*/package.json packages/*/*/package.json 2>/dev/null | tee /tmp/rename-targets.txt | wc -l
