# Command baseline observations

**Source status (2026-09-28, `AX-344`).** `horizoncode-commands` implements the typed
registry and the strict parse: only commands whose owning service exists are
registered (`/help`, `/commands`, `/usage`, `/insights`, `/skills`, each naming its owner and
effect class), an unknown name is a typed error with nearest-name suggestions, a
malformed argument names the grammar, an unavailable owner and an unsupported
surface are typed refusals, and help, command discovery, and completion are generated
from the same registry. The session-content `/search` command and
`hzcode sessions search` CLI are not implemented. Nothing falls through to a
model prompt. The composer-reference
parser recognizes the six namespaces, keeps `@name`/email/unknown-delimiter text
literal, diagnoses an unknown namespace or malformed mention without blocking, and
supports quoted paths; parsing is not resolution and grants no authority. The rest
of the table above is still a proposed product contract: these commands register as
their owners land, mention resolution/attachment is `AX-319`/`AX-340` context and
registry work, and no local attach API exists.
`analytics stats|export` and `audit verify|replay|census` are CLI subcommands, not
aliases in the interactive registry unless explicitly registered later. The CLI attach
equivalents are `hzcode run start <run-id> --spec-digest <digest>`,
`hzcode run attach <run-id> --after-seq <n>`, and
`hzcode run resume <run-id>`. Start, attach, and resume have separate contracts.
Neither remote SSH attach nor
remote hosting is part of this local-supervisor contract.


Current facts are based on the source snapshot named above. The ACP repository says
wire compatibility is negotiated with `protocolVersion`, with stable wire protocol
version 1; its 1.9.1 changelog entry is an SDK/schema release, not wire protocol
version “1.9.1”. The ACP Registry describes a curated authentication-capable agent
catalog with distribution descriptors. OpenAI and OpenCode expose agent trees,
delegation views, profile/role configuration, and model/profile controls; their
particular session and usage observability is not assumed to be universally available
through ACP. See the [ACP protocol repository](https://github.com/agentclientprotocol/agent-client-protocol),
[ACP changelog](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/CHANGELOG.md),
[ACP Registry](https://github.com/agentclientprotocol/registry),
[OpenAI multi-agent documentation](https://developers.openai.com/api/docs/guides/agents-api/multi-agent),
[OpenCode agents documentation](https://opencode.ai/docs/agents),
[`research docs/codex.md`](../../research%20docs/codex.md), and
[`research docs/opencode.md`](../../research%20docs/opencode.md). Registry contents,
protocol releases, and agent capabilities are volatile and must be rechecked when
implementation begins (`REQ-RESEARCH-001`).


### AX-405 headless cost inspection slice (2026-09-30)

The existing `horizoncode -p "/skills show <name>"` path now includes content-free
body bytes, a labelled approximate token heuristic, estimate scope and explicit
unknown observed injection/activation counts. No provider configuration is needed.
Errors from digest-bound inspection are configuration refusals before any report
is printed; they never fall through to a model prompt. This is not the interactive
Skills panel or full ACC-UX-12 acceptance.

