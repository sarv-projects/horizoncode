# 5. Security, effects, and extension boundaries

## 5.1 Security objective and limits

The kernel is the authority for application-mediated effects, but a permission prompt
is not OS isolation. Every guarantee is labeled as **enforced**, **capability-limited**,
**best-effort**, or **none**, with platform/backend and residual recorded. A UI badge,
policy record, generated schema, process wrapper or successful mock cannot prove
filesystem, process or network confinement.

The product must not claim Guard coverage for effects performed inside an opaque
provider-hosted tool, arbitrary plugin, external agent, MCP server, or tool path that
bypasses the kernel. Where the host cannot intercept and enforce an effect, report the
gap and either disable it in governed mode or place it behind an explicit, separate
trust choice with honest residuals.

## 5.2 Threat boundaries

Treat all model output, repository instructions, files, issue text, web content, MCP and
ACP responses, plugins, skills, process output and event payloads as untrusted data.
They cannot grant authority or alter approved Scope/Policy. Main threats include:

- malicious prompt/repository content attempting tool/secret exfiltration;
- confused-deputy requests that claim a different user, Thread, Run, workspace or
  approval;
- path traversal, symlink/TOCTOU, stale workspace writes and multi-repository escape;
- shell, formatter, LSP, MCP, plugin or agent subprocess abuse and inherited environment;
- arbitrary plugin code mutating host state or intercepting auth/tool arguments;
- provider route/endpoint substitution, SSRF, redirect leakage and credential exposure;
- replayed or duplicated requests after crash, timeout, disconnect or uncertain effect;
- stale evidence, stale profile/plugin generations, or hidden peer operations;
- untrusted project config being mistaken for user/managed security policy.

## 5.3 Authority derivation

All authority requests flow through this chain:

```text
authenticated local/API principal
  ∩ system/managed policy floor
  ∩ user security policy
  ∩ project restrictions
  ∩ Run policy snapshot
  ∩ Task ceiling
  ∩ profile ceiling
  ∩ exact temporary grant
  ∩ current workspace fence and execution location
```

Higher-level deny is final; lower levels only narrow. Preferences (theme/model/default
agent) have their own ordinary precedence and are not policy. Effective child authority
is the intersection of parent, profile, Task and policy. `auto-safe` may auto-resolve
only policy-designated ASK classes; it never disables Guard or overrides DENY. Broad
delete, credential export, unsafe publication and unrestricted external filesystem
remain manual/denied according to policy.

The OpenCode-derived host authenticates its public clients and forwards a private
kernel request over a pipe/OS-local socket. The kernel derives the actor and scope from
that authenticated channel/context; callers cannot supply an arbitrary principal ID.
The kernel RPC does not bind public TCP. The UI shows exact action/resource, relevant
content/policy digests, scope, expiration and effects of no response.

## 5.4 Effect authorization and settlement

Every local effect-capable operation—including shell, write/edit, subprocess, formatter,
LSP, MCP invocation, plugin call, connector, external-agent launch and integration—uses
the normalized §14 effect pipeline; this document defines no separate `EffectRequest`
schema. Before Guard, its domain owner supplies the canonical action/argument digest,
`ResourceResolutionV1`, and resulting `AuthorizationRequestV1`. The kernel:

1. validates authenticated identity, active profile/Task binding, current policy and
   workspace fence, and completes owner-specific canonical resource resolution;
2. reserves hard budget before Guard, retaining or releasing that reservation only by
   the budget settlement contract;
3. evaluates `ALLOW | ASK | DENY`; `ASK` creates a durable approval challenge bound to
   payload, policy, displayed content and resource-state digests;
4. after `ALLOW` or resolved approval, commits `EffectIntentV1` as `PREPARED`;
5. issues the exact capability lease and asks `ExecutionHost` to prepare/launch against
   the expected workspace revision;
6. captures bounded observations/artifacts and settles or retains `UNKNOWN`;
7. writes linked security audit facts without duplicating canonical Run history.

Tool schemas only describe model-call shape. Tool names, permission patterns, skills'
`allowed-tools`, profile configuration or plugin-declared capabilities do not
themselves authorize execution. Tool arguments are immutable after Guard approval;
post-authorization rewrite invalidates authorization and is rejected.

## 5.5 ExecutionHost and containment

One `ExecutionHost` owner supervises shell/check/build/test, formatters, LSP, MCP,
plugin compatibility workers, external agent CLIs and indexing helpers. It records
prepared identity, process/container reference, executable digest, environment policy,
working directory, workspace fence, limits, launch receipt, output bounds, exit
observation, cancellation and reconciliation. Child processes receive an allowlisted
environment, not the whole application environment. Secrets are passed only by
explicit scoped delivery; mark credentials visible to a child when bytes leave the
broker.

Proposed sandbox profiles: `readonly`, `workspace-write`,
`networked-workspace-write`, `full-access`. Each backend publishes supported guarantee
level and policy requirements. If a Task requires enforced containment and the active
platform cannot provide it, return `CAPABILITY_UNAVAILABLE`; do not silently downgrade
to best-effort. Windows, macOS and Linux require separate acceptance evidence.

Path authorization must normalize canonical path and resolve symlink/reparse targets
at the enforcement boundary. Bind writes to a workspace ID, fence epoch and expected
revision; reject stale writers. A preflight permission check without an execution-time
fence is not sufficient against TOCTOU.

## 5.6 Provider, network and secret handling

OpenCode `packages/llm` runs provider transports in the trusted application host.
Provider route snapshots pin provider/model/protocol/endpoint and capability metadata;
the kernel owns policy and secret references. Because an in-process host adapter needs
credential bytes, the secret broker must scope delivery to the authorized provider
request and the host is explicitly credential-bearing. Never log key/token values,
put them in prompts/artifacts/config, expose them to arbitrary plugins, or pass all
provider credentials to MCP/agents. When child delivery is unavoidable, show the
recipient and residual.

Network SSRF controls validate scheme/host/port, resolved IP ranges, redirects and
DNS-change behavior on the actual request path. Provider endpoints are configuration,
not trusted merely because the catalog lists them. No network-egress guarantee is
claimed unless an OS/container/network backend enforces it. Hosted provider tools that
execute before local authorization are unavailable in governed v1; use local mediated
tools or explicitly label capability loss.

## 5.7 Plugin, skill and protocol trust

| Extension kind | Execution boundary | Authority policy |
|---|---|---|
| Signed built-in system plugin | Host/kernel trusted release boundary | May provide sealed services only when first-party manifest and build policy name it as owner |
| Presentation plugin | UI process or declarative renderer | Read/query/render; user action token required for navigation; no canonical mutation |
| WASM extension | WASM runtime with explicit imports | Capability allowlist, fuel/memory/time bounds; actual runtime isolation must be verified |
| External-process plugin | Restricted child + typed RPC | Explicit capability lease; no kernel DB access or ambient secrets |
| OpenCode legacy server plugin | Isolated compatibility host | Translated supported hooks only; arbitrary raw Bun/shell and kernel internals unavailable |
| MCP server/tool | Local stdio child or remote protocol | Normalize schema and route calls through Guard/Effect; no auto-injected credentials |
| Skill | Inert markdown/resources until selected | Context contribution only; instructions/tools in text are untrusted and grant no permission |
| Workflow | Versioned declarative definition | Controller compiles to ordinary Goal/Spec/Run/Task, no alternate executor |
| External agent | ACP/CLI adapter and bounded workspace | Report configured/observed/enforced separately; internal tool mediation may be unknown |

Downloaded JavaScript does not run in the privileged host with unrestricted APIs. Some
plugin systems run installed Host code in-process outside the workspace sandbox; Horizon
v1 does not adopt that trust model. Policy is enforced by the operation's executor, not
only by UI filtering, tool-list omission or a wrapper that alternate callers can bypass.

Install/update stages exact bytes, checks provenance, digest/license/API/capabilities,
and stages disabled until review/probe/enable. Active work pins plugin generation.
Background plugin events cannot steal focus. Plugin commands resolve through the same
typed ActionDescriptor path as UI, slash commands, keymaps and API.

## 5.8 Recovery, audit and privacy

Effect and worker operations are at-most-once only where a real idempotency contract
supports that claim. Otherwise possible dispatch followed by missing receipt is
`UNKNOWN`, blocks conflicting scope, and enters target-specific reconciliation. Stop,
cancel, rewind and checkpoint never undo an already-settled external action. Rewind
previews owned files, preserves unrelated user edits and invalidates affected evidence.

Audit is append-only, integrity-checked and separately retained from Run projection.
Logs redact sensitive fields by schema; diagnostics must not print raw secrets or
prompt payloads by default. Data retention/deletion has explicit rules for Threads,
Runs, tool outputs, provider usage, artifacts, plugin logs and audit records. A secret
scan or redaction pass is not described as perfect; arbitrary workspace secrets remain
a residual unless positively detected and handled.

## Pinned implementation references

- [Shell tool execution path](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/opencode/src/tool/shell.ts)
- [Permission request implementation](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/opencode/src/permission/index.ts)
- [MCP transport and server integration](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/opencode/src/mcp/index.ts)
- [OpenCode repository at selected pin](https://github.com/anomalyco/opencode/tree/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322)
- [DeepSeek Harness plugin manager trust and execution notes](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/boot/plugin-manager/README.md#use-this-package)
