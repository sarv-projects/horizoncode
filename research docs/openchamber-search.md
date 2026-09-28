# OpenChamber chat and session search review

## Source pin and scope

Reviewed `fedaykindev/openchamber` at commit [`167883d452c4860c819bff0476b093feb265db1a`](https://github.com/openchamber/openchamber/commit/167883d452c4860c819bff0476b093feb265db1a), committed 2026-09-28. This note follows executable source paths and tests at that revision. It does not copy source code, and it does not claim runtime behavior was exercised.

OpenChamber has two different search features that should not be conflated:

1. A per-session timeline dialog searches user prompts already present in the selected session's loaded message records.
2. Sidebar and archive search find sessions by title, path, folder/group metadata, or exact session ID. They do not search message bodies across sessions.

## Verified behavior

### Per-session message search

[`TimelineDialog.tsx`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/chat/TimelineDialog.tsx#L42-L90) reads `useSessionMessageRecords(currentSessionId)` and filters the records to `role === 'user'`. It joins a message's text parts with newlines ([`messagePreview.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/chat/lib/messagePreview.ts#L8-L17)), trims the query, lowercases both sides, and uses literal substring matching. Therefore ordinary exact words and contiguous phrases match case-insensitively; it is not token, stem, or typo matching. Assistant responses, tool output, and non-text parts are not searched by this dialog.

The dialog shows a short context snippet, groups hits by date, and supports arrow-key selection, Enter, and click. Selection passes the message ID to the timeline controller; that controller resolves the message's turn and asks the message list to scroll to it ([`TimelineDialog.tsx`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/chat/TimelineDialog.tsx#L176-L210), [`useChatTimelineController.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/chat/hooks/useChatTimelineController.ts#L757-L790)). It does not navigate if the controller reports failure.

The search operates on the current in-memory message records, not a complete-history search API. Message loading is paginated: the loader starts with a bounded recent window and exposes an explicit `loadOlder` path ([`session-message-loader.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/sync/session-message-loader.ts#L23-L37), [`session-message-loader.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/sync/session-message-loader.ts#L338-L389)). The timeline dialog offers a manual “Load older” action ([`TimelineDialog.tsx`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/chat/TimelineDialog.tsx#L279-L295)); typing a query does not itself walk all history. A miss can therefore mean “not in loaded coverage yet,” not “absent from the conversation.” The reviewed code exposes a separate complete-history loader, but this search path does not call it.

### Session-title and archive search

The sidebar searches the current session records across project sections and standalone managed-chat groups ([`useSessionSidebarSections.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/session/sidebar/projects/useSessionSidebarSections.ts#L103-L177), [`useSessionSidebarSections.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/session/sidebar/projects/useSessionSidebarSections.ts#L194-L224)). A session's searchable text is its current title plus directory. Ordinary text queries require every whitespace-separated token to match one of those fields, with punctuation-insensitive matching and no typo/fuzzy fallback; a query beginning `ses_` instead requires a complete case-insensitive session-ID match ([`useSessionGrouping.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/session/sidebar/projects/useSessionGrouping.ts#L50-L83), matcher contract: [`fuzzySearch.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/lib/search/fuzzySearch.ts#L211-L224)). Nonmatching parent nodes remain as context when a child matches. Query submission is Enter-based, and typing alone does not repeatedly re-run the potentially large session-tree projection ([`SessionSearchInput.tsx`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/session/SessionSearchInput.tsx#L27-L82)). Tests cover managed-chat results, full-ID matching, parent context, and exclusion of archived sessions from active ID search ([`useSessionSidebarSections.test.tsx`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/session/sidebar/projects/useSessionSidebarSections.test.tsx#L87-L143)).

The archive view searches the archived-session collection by title or exact full ID. It has directory buckets when no query is active, but text search spans archived sessions and bypasses the selected-directory filter ([`ArchiveView.tsx`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/views/ArchiveView.tsx#L35-L82)). Rows show a directory label and archived/updated/created date, but there is no date-range filter in this view ([`ArchiveView.tsx`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/views/ArchiveView.tsx#L205-L233)). Its UI test covers exact IDs, case/whitespace normalization, title typo tolerance, and exclusion of active sessions ([`ArchiveView.test.tsx`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/views/ArchiveView.test.tsx#L48-L78)).

The global session list is paged and client-merged into active and archived collections; archive membership is split client-side ([`globalSessions.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/stores/globalSessions.ts#L48-L115), [`useGlobalSessionsStore.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/stores/useGlobalSessionsStore.ts#L676-L725)). This is session metadata discovery, not a message-content index.

### Rename behavior

Rename calls OpenCode's session update API and then re-fetches the canonical session record before upserting global and live stores ([`session-actions.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/sync/session-actions.ts#L1783-L1800); adapter mapping: [`client.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/lib/opencode/client.ts#L842-L848)). Tests assert the fresh title is published and the correct per-session/worktree directory is used ([`session-actions.test.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/sync/session-actions.test.ts#L1268-L1305)). Because sidebar search matches the title on the current session records, this design avoids a separately indexed stale title. The tests verify rename/store publication, not an end-to-end “rename, then search” interaction.

## Search-specific data model and index lifecycle

The UI's OpenCode-facing message model carries stable `id`, `sessionID`, role, timestamp, and message-specific fields ([`model.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/lib/opencode/model.ts#L147-L179)); text content is represented in message parts, and the timeline helper reads text parts only ([`messagePreview.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/chat/lib/messagePreview.ts#L8-L17)). In the reviewed OpenChamber path, matching is performed in the UI over those records. The OpenChamber session routes reviewed here provide create/archive/metadata/unarchive/send/fork operations, not message search ([`routes.js`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/web/server/lib/openchamber-sessions/routes.js#L1008-L1060)). I found no search-specific persistent schema, FTS index, backfill/rebuild routine, or server query in these feature paths. This is a scoped source finding, not proof that no unrelated package contains any search facility.

Tests cover the title-search input's Enter/IME/clear/performance behavior and archive/sidebar filtering, but this revision has no dedicated `TimelineDialog` search test file in `packages/ui/src`; the user-message-only and substring rules above are established directly from its implementation. I did not execute tests.

## Fit for HorizonCode

| Requested capability | What this source demonstrates | Fit and limitation for HorizonCode |
|---|---|---|
| Search inside a conversation | Fast client-side, case-insensitive literal search over loaded user prompts; snippet and keyboard navigation | Useful interaction pattern. Expand searchable roles/content explicitly and search full durable history or clearly expose coverage/loading state. |
| Search all conversations | Sidebar locates sessions by current title/path/ID; it does not search message bodies globally | Insufficient for cross-session chat search. Horizon needs a distinct global message-search query over its durable transcript projection. |
| Exact words/phrases | Timeline uses literal substring; sidebar title/path needs all tokens without fuzzy fallback; archive titles use ranked fuzzy matching | Keep distinct modes: phrase/exact versus token/fuzzy. Do not silently make exact chat search typo-tolerant. |
| Jump to a matching message | Result identifies a stable message ID; controller resolves turn and reveals the target | Strong pattern. For Horizon, carry `(session_id, message_id)` plus revision/cursor, fetch missing history around the match, then reveal/highlight; a result ID alone is not enough if its history is unloaded. |
| Renamed sessions | Search reads current session metadata; rename re-fetches/upserts the canonical record | Good stale-title avoidance. Horizon should key index rows by immutable session ID and update denormalized current title/project labels on rename. |
| Project/date filters | Project/group structure organizes the session list; archive has directory buckets and dates, but no conjunctive project/date filters while searching | Horizon should make project and date constraints explicit query filters that compose with text, for archived and active records. |
| Rebuild/consistency | Search depends on loaded UI stores; no independent message-search index lifecycle in reviewed paths | Horizon's index should be derived/rebuildable from canonical message events, update atomically or via a replayable outbox, handle edits/deletes/retention, and report incomplete/stale coverage rather than silently omitting results. |

These Horizon recommendations are a proposed synthesis, not behaviors implemented by OpenChamber. A reasonable local-first design is a rebuildable SQLite full-text projection keyed by immutable `(session_id, message_id)` with project ID, timestamp, current title, searchable role/content, and source revision. Search-result navigation should rehydrate from canonical session history and highlight the match. Keep the event/session store authoritative; the index is disposable derived state. Decide separately whether tool output, hidden reasoning, file attachments, or archived/deleted records are searchable, since OpenChamber's timeline does not settle those product or privacy rules.

## Source coverage limits

- Inspected the relevant UI timeline, message-text helper, session grouping/archive search, global session pagination/store, rename action/API adapter, tests, and OpenChamber session routes at the pinned commit.
- Did not trace every app surface or upstream OpenCode server implementation. “No search endpoint/index” is limited to the reviewed OpenChamber feature paths.
- No source code or test was copied or executed; no live service was called. Implementation evidence is not a runtime acceptance result.

## Follow-up findings and HorizonCode LLD corrections (2026-09-28)

The current global session pagination publishes an initial page and incrementally
merges later pages. Sidebar search counts only the currently materialized session
records; I found no coverage/count contract tying that count to pagination completion.
Therefore a low/zero count during initial loading is not a complete global-search
result. See pinned [`globalSessions.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/stores/globalSessions.ts#L55-L113),
[`useGlobalSessionsStore.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/stores/useGlobalSessionsStore.ts#L690-L725),
[`useSessionSidebarSections.ts`](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/session/sidebar/projects/useSessionSidebarSections.ts#L194-L224),
and [sidebar status](https://github.com/openchamber/openchamber/blob/167883d452c4860c819bff0476b093feb265db1a/packages/ui/src/components/session/sidebar/useSidebarGroupStatus.ts#L57-L65).
The message timeline still searches loaded user-message text by literal substring;
the historical VS Code changelog describes a broader earlier timeline search, but that
is not active behavior at this pinned head. The timeline dialog has no dedicated test
found in the reviewed UI test paths.

HorizonCode's previous search LLD had an under-specified sort tie-break: title hits
have title-event sequence, whereas message hits have message sequence. Equal time/rank
across those kinds could make pagination unstable. `ARCH/07` now defines a total order
including hit kind, source event sequence, and unique hit identity; cursors are keyset
cursors bound to extractor/index/catalog generation. It also states how simultaneous
title/body matches collapse (message hits carry title context; suppress redundant
title-only row), versions deterministic extraction from displayed message revisions,
and hides opt-out tool-output results immediately before purge completes.

Coverage is now explicit across both full-text indexing and global Thread enumeration:
`COMPLETE` requires a stable authorized catalog snapshot, matching scope digest and
counts, all captured committed heads indexed, and zero issues. The bounded diagnostic
head sample is not complete-scope proof; catalog pagination/loading invalidates
complete status and cursors. See `REQ-SESS-007`, `ARCH/07`, `ACC-P1-14`, `AX-369`, and
the equal-key, replacement/edit, simultaneous title/body, initial global-load, and
pre-purge opt-out cases in `research docs/tests.md`.
