# Command Code: preference-learning concept review

> INTERNAL RESEARCH — reviewed 2026-09-27. Public snapshot: main, commit `5c8f1b48c9d6704210cb3f9a476fdcffe5093e9a`. The public repository contains a README and GitHub metadata, not the product implementation; this is a claim-boundary note, not an LLD reconstruction.

## What can be established

Command Code's public materials describe a coding agent that adapts to a user's preferences from accepted, rejected or edited changes and maintains a style/taste profile. Product docs describe the concept as “taste” or “meta-neuro-symbolic” behavior. The public GitHub snapshot does not expose the implementation, storage schema, learning algorithm, data flow, training/evaluation procedure, or a deployable agent runtime. The repository snapshot also has no visible license file, so code reuse is not authorized by assumption.

## Architecture and schema status

**Not publicly verifiable:** model or rules architecture; preference schema/versioning; event provenance; confidence/decay; per-repository vs global scopes; privacy/retention; conflict resolution; undo/forget controls; whether edits are labeled automatically; protection against poisoning; any relation to task planning or verification.

An evidence-backed architecture diagram or LLD schema cannot be produced from the available source. Anything beyond the claims above would be inference, not a codebase deep dive.

## Questions a serious evaluation should ask

- What exact user event creates a preference signal: explicit accept, partial edit, merge, or mere non-rejection?
- Can a learned preference be inspected, corrected, scoped, expired and deleted?
- Does it preserve the source example and confidence, or collapse inference into a hard rule?
- How are user preference, project policy, explicit request and security requirements prioritized?
- Does a preference ever change requirements, tests, permission scope or completion criteria?
- Are the learning and retrieval behaviors benchmarked against an unpersonalized baseline?

## Relevance to HorizonCode

The safe reusable idea is a transparent, user-controlled preference store for style choices (formatting, naming, explanation detail). A preference must be low-authority: it cannot override explicit instructions, repository policy, approved specification, security controls or user acceptance. Store evidence/source, scope, confidence, last-confirmed time and a correction/deletion path. Do not represent inferred taste as confirmed intent.

## Sources

[Public repository](https://github.com/CommandCodeAI/command-code) · [Product docs](https://commandcode.ai/docs)
