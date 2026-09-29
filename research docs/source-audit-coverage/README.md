# Upstream source-audit coverage ledgers

These ledgers make the inspected file set auditable. They are inventories of a
bounded review, not proof that every line in an upstream repository was read.
`FULL` means the reviewer read the file contents; `PARTIAL` means targeted ranges
or sections were read; `UNREAD` means the file was inventoried but not read in full.
Candidate counts depend on each ledger's declared file-extension filter and must not
be compared as if repositories had identical inventories. Read the linked research
note for the question, exact source references, exclusions, and conclusions.

| Repository | Pinned revision | Ledger | Coverage summary |
|---|---|---|---|
| OpenCode | `083ed266e058dc3d2d1b377ff5540859d79de110` | [CSV](opencode-083ed266.csv) | 3,630 selected files; 14 full, 10 partial, 3,606 unread. |
| Cline | `787ad1b077d8b697892dc3bfcd42e7c65b88789e` | [TSV](cline-787ad1b.tsv) | 3,521 selected candidates; 16 full, 8 partial, 3,497 unread. |
| DeerFlow | `8a3a309d1ce8bac8418251be29d4e4297a20c5eb` | [CSV](deer-flow-8a3a309d.csv) | 2,700 selected code files; 10 full, 14 partial, 2,676 unread. |
| DeepSeek Harness | `4878cdabd87d4041bdaff61d04c966883b9fd07a` | [TSV](deepseek-harness-4878cdab.tsv) | 5,484 selected code files; 2 full, 9 partial, 5,473 unread. |
| Superset | `f37599e2774a99dce67f21b887c88bac331da6fc` | [CSV](superset-f37599e.csv) | 8,569 selected source candidates; 8 full, 3 partial, 8,558 unread. |
| OpenHands Agent Canvas frontend | `f174ba8465233e46e66ab2c5667b358f1d6676d6` | [CSV](openhands-frontend-f174ba84.csv) | 2,094 selected source candidates; 4 full, 6 partial, 2,084 unread. |
| OpenHands software-agent-sdk | `71612374a8d3c639909b03613dbecf1ff999d0bd` | [Focused report](openhands-sdk-71612374.md) · [TSV](openhands-sdk-71612374.tsv) | 1,787 tracked paths inventoried (1,341 Python); 8 full, 8 partial, 1,771 unread. Targeted only: event persistence/recovery, ACP resume primitive, and storage benchmarks. |
| OpenHands/OpenHands Agent Canvas | `94e156a8c7b7a468d7c60bda3a38757bfbfd4a79` | [Focused report](openhands-94e156a8.md) · [TSV](openhands-94e156a8.tsv) | 2,115 selected source candidates; 27 full, 13 partial, 2,075 unread. Targeted frontend/API/event transport/security review; not exhaustive. |
| Ruflo | `fce8e6da5a6edda3791367b244066e6c67730196` | [Focused report](ruflo-fce8e6da.md) · [TSV](ruflo-fce8e6da.tsv) | 2,993 selected code files; 5 full, 2,988 unread. Named V3 swarm/memory/MCP paths only; not exhaustive. |
| Nanobot | `b7abbcd70b9d21bb3f7052699195eb39693b7615` | [Focused report](nanobot-b7abbcd7.md) · [TSV](nanobot-b7abbcd7.tsv) | 1,249 selected code files; 4 full, 21 partial, 1,224 unread. Subagents, sessions, bus, providers, sandbox only; not exhaustive. |
| Hermes Agent | `ea114c3e98c3339e13004adfc6098cf28ed7d754` | [Focused report](hermes-agent-ea114c3e.md) · [TSV](hermes-agent-ea114c3e.tsv) | 12,376 selected code files; 4 full, 13 partial, 12,359 unread. Lifecycle, registry, delivery, routing, tool executor only; not exhaustive. |
| ECC | `d3b8a3e908904e242ed2dbe66af62cca71131419` | [Focused report](ecc-wshobson-agent-catalogs-20260929.md) · [CSV](ecc-d3b8a3e90890.csv) | 2,293 selected paths; 6 full, 8 partial, 2,279 unread. Harness/plugin definitions and hooks only; not exhaustive. |
| wshobson/agents | `156b7a5e7a8b93642628a339ee4039c925b34c7f` | [Focused report](ecc-wshobson-agent-catalogs-20260929.md) · [CSV](wshobson-agents-156b7a5e7a8b.csv) | 1,168 selected paths; 2 full, 10 partial, 1,156 unread. Catalog adapters/generator/installer only; not exhaustive. |

See [targeted source findings](targeted-superset-openhands-findings.md) for evidence-backed
design implications and the single unrepresented benchmark detail identified in those
two passes.

Codex does not yet have a durable per-file ledger in this directory. Its research note
records narrower source coverage; do not infer exhaustive reading from that note.

The inventory scripts and original temporary reports were not committed. These ledgers
preserve the reported per-file status only; they do not include file contents or replace
upstream license/provenance review. Refresh a ledger when its pinned commit or file
selection changes, and retain the original source pin in the corresponding research
note.
