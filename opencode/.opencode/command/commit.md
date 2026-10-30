---
description: git commit and push
subtask: true
---

commit and push

make sure it includes a prefix like
docs:
tui:
core:
ci:
ignore:
wip:

For anything in the packages/web use the docs: prefix.

prefer to explain WHY something was done from an end user perspective instead of
WHAT was done.

do not do generic messages like "improved agent experience" be very specific
about what user facing changes were made

if there are conflicts DO NOT FIX THEM. notify me and I will fix them

Before committing, inspect the working tree with the `git_status` and `git_diff` tools (include staged and unstaged changes). Compose the commit message from that evidence, then use `bash` only for `git add`, `git commit`, and `git push` when the tree is ready.
