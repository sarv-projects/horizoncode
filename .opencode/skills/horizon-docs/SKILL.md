---
name: horizon-docs
description: Development compatibility shim for the canonical HorizonCode architecture/status skill.
---

# Horizon Docs — OpenCode compatibility shim

This file exists only so the current OpenCode-based development harness can discover the
`horizon-docs` skill before HorizonCode's product-owned embedded built-in registration is wired.

**Canonical product source:**
`packages/core/src/horizon/skills/horizon-docs/SKILL.md`

Read that canonical skill file and follow it. Do not treat this `.opencode` copy as product
authority, do not add HorizonCode product behavior here, and do not make `.opencode/` a required
runtime location for HorizonCode built-ins.
