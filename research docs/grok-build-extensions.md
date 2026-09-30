# Grok Build Extensions surface and slash routing

**Evidence scope.** I inspected the pinned public source snapshot at Grok Build commit
[`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8),
dated 2026-09-29. Its repository license is Apache-2.0. This is a focused review of
the pager Extensions surface and command routing, not a full repository audit. No code
was copied.

## Observed behavior

- `xai-grok-pager/src/views/extensions_modal.rs` defines one `ExtensionsModalState`
  with six category tabs: Hooks, Plugins, Marketplace, Skills, Workflows, and MCP
  Servers. It uses shared `ModalWindow` chrome and owns category-specific data,
  filters, selection, action, and confirmation state.
- `xai-grok-pager/src/slash/commands/plugin.rs` routes `/hooks`, `/plugins`
  (alias `/plugin`), `/marketplace`, and `/skills` to typed
  `Action::OpenExtensionsModal` results with the corresponding initial category.
  `mcps.rs` routes `/mcps` to MCP Servers; `workflows.rs` routes `/workflows` to
  Workflows. In the pinned upstream snapshot the MCP and skills forms are plural.
- `xai-grok-pager/src/app/dispatch/transcript.rs` constructs the modal and returns
  effects to populate the categories. It starts fetches for all categories, including
  marketplace; that fan-out is a source behavior, not a requirement HorizonCode copies.
- The pager's `builtin_commands()` currently registers 74 static built-ins. The live
  slash catalog also receives backend ACP commands and user-invocable skills/workflows;
  74 is therefore not the total command universe.
- `/workflow` is separate from `/workflows`: the former is a command/control path for
  workflow operations, while the latter opens the Workflows catalog tab.
- At this source pin, `compact.rs` rejects nonempty `/compact` arguments. Slash behavior
  is revision-sensitive; inspect the exact source snapshot instead of treating an
  older guide or prior checkout as current behavior.

## HorizonCode disposition

Adopt the one-overlay, command-to-category navigation pattern under `DEC-078` and
`REQ-UI-020`. HorizonCode intentionally adds singular aliases for MCP and skills and
keeps `/workflow` bound to the existing Run controller. Its category data fetches are
bounded and cancellable, with visible loading/empty/stale/error states; opening an
overlay is navigation only. Search/install, trust, enablement, permission, and
execution remain separate HorizonCode-owned stages. See `SRC-029` and `U-GROK-EXTENSIONS`.
