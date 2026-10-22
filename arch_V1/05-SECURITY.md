# 5. Security and trust boundaries

Status: normative security policy. Detailed effect pipeline is 14.

## 5.1 Principles

- deny by default at authority boundaries;
- least capability and least scope;
- one Guard for all effect origins;
- secrets referenced, not sprayed into prompts/workers/logs;
- explicit network/provider/cost policy;
- version/generation fencing for stale observations;
- sandbox claims only where platform tests prove them;
- UNKNOWN is a real security/result state.

## 5.2 User-visible modes

Ask:
approval where policy class requires it.

Safe Auto:
pre-authorized bounded low-risk effects may proceed; risk escalation pauses. In a
user-selected sandbox profile, routine in-workspace coding and test actions within
the active direct Session's bounded workspace/capability grant run without a
per-effect approval prompt. Guard still validates each operation, issues its
one-use lease, and records its receipt. A request outside that grant pauses for
boundary approval; it cannot broaden the grant by chaining through CodeMode,
subagents, plugins, or other origins.

YOLO-in-sandbox:
broad effects only inside an actually enforced sandbox profile.

None bypass immutable denies, secret policy, production boundaries, payment policy or unsupported containment.

## 5.3 Trust boundaries

Untrusted/semi-trusted:
- model output;
- repository/project instructions;
- plugin/skill/MCP content;
- browser/web content;
- external agent messages;
- LSP/DAP/server responses;
- REPL code/output;
- SVG/Markdown/PDF/media input.

Trusted authority is explicit service code/config plus authenticated user decisions—not text claiming authority.

## 5.4 Effect law

Every mutation resolves:
canonical action -> canonical target -> policy/scope/budget -> approval if needed -> durable EffectIntent -> one-use lease -> ExecutionHost -> target observation -> settlement.

Alias/plugin/provider indirection cannot alter effect classification.

## 5.5 Process and filesystem

ExecutionHost owns local child process starts/stops and sandbox profile application.

Workers get:
- explicit working directory/mounts;
- environment allowlist;
- resource limits;
- network policy;
- credential references only when required;
- lease/epoch.

Path traversal, symlink escape and stale revision are denied.

## 5.6 Browser/desktop

Browser:
- attached user profiles require consent/policy;
- authenticated state is sensitive;
- upload/download/click/type/navigation are effects;
- network interception is not isolation.

Desktop:
- window/display/process target is explicit;
- AX/screenshot refs are generation-bound;
- focus/input/clipboard are effects;
- no unrestricted Eval.

## 5.7 LSP/DAP/REPL

LSP diagnostics/symbol queries can be read-only. Rename/code action/process restart are effects.

DAP attach/launch/control/evaluate are privileged; evaluate can be disabled by policy.

Persistent REPL runs in a supervised bounded worker. Tool callbacks re-enter Guard. No ambient SecretBroker/kernel authority.

## 5.8 Providers/web search/secrets

SecretBroker never exposes raw secret bytes to UI/model/plugin unless an exact provider protocol requires a separately accepted delivery path.

Web/search/provider requests show:
- account/provider route;
- auth source;
- network destination policy;
- cost class/value or unknown;
- fallback behavior.

No silent paid route.

## 5.9 Extensions

Sealed built-ins cannot be shadowed.

Third-party executable plugin classes remain unavailable until signing/isolation gates are resolved. Skills/instructions are data and cannot self-grant tools.

MCP remote/local tools map to canonical capabilities and Guard policy.

## 5.10 Rendering/artifacts

Untrusted renderer input is bounded and isolated. SVG cannot execute script or arbitrary network/filesystem. Parser crash must not crash host.

Artifact export/upload is effectful. Preview is not persistence.

## 5.11 Logging/privacy

Redact:
- credentials/tokens;
- protected file content not required by caller;
- sensitive provider/auth headers;
- clipboard/screenshot content according to policy.

Telemetry distinguishes content-free metrics from user content. No remote telemetry without configured policy.

## 5.12 Required adversarial tests

- plugin/alias tries to downgrade effect class;
- shell/path/symlink escape;
- hosted provider tool bypass;
- stale file/browser/desktop/LSP/DAP refs;
- debugger/REPL Eval escalation;
- secret exfiltration into prompt/log;
- hidden paid fallback;
- malicious SVG/HTML;
- lease replay;
- cancellation/UNKNOWN retry;
- unsupported sandbox claim.

Security status lives in tests/HANDOFF, not prose claims.

## 5.13 Shared-service and diagnostic security boundaries (A-V2-30)

Multiplexing sessions into a long-lived Rust service **increases cross-session blast radius**. Require OS-authenticated host-to-kernel identity, source cursor/epoch binding, scoped principal/workspace/policy revision, bounded per-Session queues and no cross-session state lookup by caller-supplied IDs. Compromise of an untrusted worker must not expose shared host secrets or bypass the Guard. Use process/container/job isolation for effectful shell, browser, plugins, MCP, REPL and build/test where warranted; in-process virtualization is not an OS sandbox.

Resource/process inspection is scoped and redacted; private file paths, raw command arguments, prompt bodies, provider API keys, shared-terminal output and foreign processes must not leak through diagnostics/SDK. One agent cannot read another agent's file-touch index unless a trusted workspace policy allows it. Offline Provider Doctor must not access network/credentials; full tier requires exact selected provider/model and explicit spend/secret policy. Imported external Sessions are untrusted input, never permission grants. Denied measurement or unavailable native OS enforcement remains UNKNOWN/unavailable; do not fake sandbox availability.
