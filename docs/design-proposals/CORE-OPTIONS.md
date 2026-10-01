# Core design options

These unresolved alternatives require a separate design and acceptance before changing the canonical blueprint. Original question lists and resolved history remain in the frozen architecture archive.

## Distributed ownership and external history

Multi-node Thread ownership is outside the same-host contract. A clustered owner needs lease/fencing and partition behavior. Importing foreign agent histories needs an explicit normalized import format and provenance policy; native Thread replay is not authority transfer.

## Context calibration

Per-model-class buffer/tail/summary allowances, repo-map personalization strength and tokenizer uncertainty calibration require recorded representative workloads. The blueprint fixes the 50% trigger, mandatory hard-fit guard and bounded defaults; calibration cannot disable them. Eval-probe curation and regression thresholds need versioned test fixtures. Optional index-exchange producers need concrete format/compatibility fixtures.

## Compression experiments

Small local prose encoders, extractive retrieved-context pruning, code-aware span selection and RAPTOR-style hierarchical summaries require footprint, privacy, freshness and task-quality evaluation. No encoder or hierarchical summarizer is automatically enabled by a flag. Additional deterministic formatter command families need exact exit/stdout/stderr/recall fixtures before activation.

## Provider integrations and evaluation

Each independent OAuth/client registration needs provider-specific authorization and conformance evidence. Unsupported reasoning-effort values must fail typed until an explicit tested mapping is provided. Model-eval score publication and signature policy need versioned source ownership before enabling an optional score gate.

## Configuration extensions

YAML authoring for the primary configuration, transform hooks and mandatory remote-skill signing are separate proposals. JSONC remains primary; skills use YAML frontmatter within Markdown, and existing hook/extension trust contracts remain effective.
