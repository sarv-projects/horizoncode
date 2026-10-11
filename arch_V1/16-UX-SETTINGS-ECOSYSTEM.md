# 16. UI, actions, settings and provider/model experience

Status: normative V1 UX contract. It describes presentation over existing owners; UI never becomes an authority store.

## 16.1 Surfaces

Retain and adapt existing OpenCode TUI, Solid app/web and Electron desktop surfaces.

All surfaces expose the same conceptual state/actions:
- Session/chat;
- project/workspace;
- agent/harness/model selection;
- context/files;
- terminal/build/test;
- Goal/managed work;
- permissions/effects;
- artifacts/evidence;
- extensions/settings.

Layouts may differ by terminal/desktop capabilities but action semantics are identical.

## 16.2 Prompt bar

The prompt composer must expose:
1. selected AgentProfile/harness identity;
2. model selector constrained by that agent/harness compatibility;
3. optional Goal/managed-mode state;
4. attachments/context refs;
5. send/stop/interrupt state.

Changing the model does not silently change the harness. Changing agent/harness recomputes eligible models but does not silently bill/connect a new provider.

Draft text survives picker/modal/settings transitions.

## 16.3 One ActionDescriptor

Every user/model-invocable action projects from one canonical descriptor:
- action/capability ID;
- slash command and aliases;
- semantic icon key;
- description/help;
- arguments schema;
- availability/disabled reason;
- effect class;
- required scope/capabilities;
- owner;
- dynamic status summary;
- supported surfaces.

Slash completion, command palette, menu/button, keybinding, CLI/SDK representation and model tool presentation cannot diverge in execution semantics.

Alias resolves before Guard. Sealed built-ins cannot be shadowed.

## 16.4 Slash and command discovery

Autocomplete is searchable and keyboard-first.

Show:
- semantic icon;
- canonical command;
- concise description;
- current state where useful;
- disabled reason.

Use semantic icon keys with Unicode/Nerd/ASCII fallback and grapheme-aware width. Emoji/icon presentation never becomes the command ID.

## 16.5 Agent/harness/model provider hub

Compact picker:
- current Session model only;
- filtered by selected agent/harness.

Full hub:
- recent;
- role assignments;
- all models;
- providers/accounts;
- local runtimes;
- search/media/embedding/rerank providers where supported.

Model kinds can include chat, tiny, image, TTS, STT, search, judge, embedding, rerank and video. Presence in a catalog is not proof the endpoint is enabled.

For each model/provider show only source-backed metadata:
- provider/account/model;
- auth state;
- context/output limits;
- modality/tool/reasoning support;
- measured/declared speed with provenance;
- pricing class/value/freshness or unknown;
- availability/error;
- compatible harnesses.

No green/available state from static source files alone.

## 16.6 Role bindings

Optional workload roles can bind explicit model/provider/harness policy, such as default, fast, thinking, vision, architect, commit, tiny, memory, subtask, advisor, image, web, speech, dictation and judge.

Role binding is configuration, not automatic hidden routing. Fallbacks are explicit, scoped (global/project/Session where supported) and show cost/auth implications before use.

## 16.7 Provider connections

Reuse existing OpenCode/Horizon provider/auth ownership.

Supported connection forms according to adapter:
- OAuth/device/browser login;
- API key stored as SecretBroker/OS-credential reference;
- environment credential source;
- keyless local runtime;
- custom compatible endpoint with TLS/auth policy.

UI never stores or displays raw secret material after entry.

Test/refresh/discovery network requests show whether they can consume paid quota. Unknown cost is not free.

Search provider, model provider and agent harness are separate categories even if backed by the same company/account.

## 16.8 Settings

Settings are schema-driven and searchable.

Each field exposes:
- key and description;
- type/constraints;
- requested value;
- effective value;
- source layer;
- default;
- shadowed/locked state and reason;
- apply boundary: live, next turn, next Session, restart;
- validation error;
- reset/revert.

Scopes: system/default, user, project/workspace, Session where supported. The owning config service defines precedence.

Conditional settings hide/disable irrelevant controls without destroying stored values.

Theme/layout settings may live-preview and must be revertible.

## 16.9 Goal objective UI

Goal editor holds a draft only.

It supports:
- objective;
- scope/constraints;
- acceptance criteria;
- time/token/cost/resource budgets;
- external editor;
- review/diff when revising an accepted spec.

Submitting the draft creates/revises reviewable Goal/SpecVersion. It does not start effects. Start Run occurs only after accepted SpecVersion and normal permissions.

## 16.10 Permissions and operational state

Show:
- Ask/Safe Auto/YOLO-in-sandbox mode;
- pending approval with exact action/target;
- effect status including UNKNOWN/reconciling;
- selected model/provider/harness;
- budget/usage provenance;
- backend unavailable reason;
- managed Run/Task state without confusing it with Session state.

Do not show unsupported containment as safe.

## 16.11 Extensions

Agents, skills, hooks, MCP and plugins use 29.

The UI projects their:
- source/provenance;
- version;
- requested/allowed capabilities;
- trust class;
- enabled scope;
- conflicts/shadowing;
- health.

Installing/enabling executable extensions is an effect and may be unavailable pending release/security gates.

## 16.12 Accessibility and keyboard contract

- all functions keyboard reachable;
- focus restored predictably after modal/picker;
- no streaming update steals input focus or scroll;
- screen-reader labels/ARIA equivalent in GUI;
- terminal text fallback for every graphic;
- color is never the only status signal;
- narrow terminals collapse rather than truncate critical authority/cost/error state.

## 16.13 UX acceptance

Required end-to-end cases:
- agent selection filters model picker correctly;
- model change does not change harness;
- provider login failure preserves draft/state and no secret leaks;
- explicit project/global role binding and paid-fallback denial;
- alias/slash/button/keybinding dispatch same action ID;
- settings requested/effective/source/locked behavior;
- Goal draft survives external editor and cannot start work before acceptance;
- unsupported backend shows reason;
- permission/effect UNKNOWN is understandable;
- TUI and desktop expose equivalent underlying action/state.

Source inspiration may come from OMP or other products through 42, but this document is the only normative UI contract.
