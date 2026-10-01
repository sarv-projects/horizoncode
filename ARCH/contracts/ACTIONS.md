# Actions

```text
ActionDescriptor {
  action_id, owner, label, help, input_schema, target_kind,
  allowed_surfaces, availability, unavailable_reason,
  button_locations, command_ids, key_binding_ids,
  effect_class, confirmation_policy, apply_boundary,
  request_method, receipt_schema, event_classes, result_view
}
```

CommandDescriptor is the strict command grammar linked to action_id; it is not a
second business dispatcher. Each button/key/palette entry uses that same action.
Unbound or colliding shortcuts retain a help/palette route; editor/composer focus and
IME/paste cannot trigger destructive bindings accidentally. Escape dismisses navigation
or interrupts only under its documented focus/active-operation rule, never implicit
approval. Duplicate mutation clicks query their stable delivery receipt. Read-only
buttons do not consume mutation nonces or spend.


## Admission and results

Every mutation resolves exact target identity, validates typed arguments and current scope, uses a stable delivery ID, and returns the owner's durable receipt. Duplicate clicks query/reuse that receipt; a changed payload under the same ID conflicts. Read actions use authenticated ReadContext, not mutation nonces. Failure distinguishes not started, committed, running and UNKNOWN.

Each surface specifies loading, unavailable, empty, partial, error and success rendering, keyboard/mouse equivalents, focus restoration and failure recovery. Availability comes from the real owner/capability snapshot. Settings expose requested/effective value, provenance and apply boundary. An implementation must not expose an active button with an absent route or use an unsupported command as a model prompt.

The action catalog is maintained in Commands and Settings; this file owns its common descriptor and dispatch laws. Stable Stop, Cancel, Undo and Retry are separate actions; their meaning never changes under a user's pointer during streaming.
