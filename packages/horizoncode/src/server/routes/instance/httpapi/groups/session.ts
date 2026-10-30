import { PermissionV1 } from "@horizoncode/core/v1/permission"
import { Permission } from "@/permission"
import { SessionV1 } from "@horizoncode/core/v1/session"
import { SessionV2 } from "@horizoncode/core/session"

import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Info as FileDiffSchema } from "@horizoncode/schema/file-diff"
import { Schema, Struct } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { ApiNotFoundError, ConflictError, ForbiddenError, PermissionNotFoundError, ServiceUnavailableError, SessionBusyError } from "../errors"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@horizoncode/core/provider"
import { ModelV2 } from "@horizoncode/core/model"
import { QuestionV2 } from "@horizoncode/core/question"
import { SubagentStatusV1 } from "@horizoncode/schema/subagent-status-v1"

const root = "/session"
export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scope: Schema.optional(Schema.Literals(["project"])),
  path: Schema.optional(Schema.String),
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})
export const DiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  ...Struct.omit(SessionSummary.DiffInput.fields, ["sessionID"]),
})
export const MessagesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  before: Schema.optional(Schema.String),
})
export const SubagentWaitQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  timeoutMs: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(30_000),
  ),
})
export const SubagentMessagePayload = Schema.Struct({
  requestId: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(128)).check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/)),
  mode: Schema.Literals(["queued", "follow_up"]),
  content: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(16 * 1024)),
})
export const SubagentMessageResult = Schema.Struct({
  status: Schema.Literals(["QUEUED", "FOLLOW_UP_SCHEDULED", "UNKNOWN", "NEEDS_APPROVAL", "UNAVAILABLE", "DENIED"]),
  messageId: Schema.NullOr(Schema.String),
  mailboxSequence: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  challengeId: Schema.NullOr(Schema.String),
  effectId: Schema.NullOr(Schema.String),
})
export const StatusMap = Schema.Record(Schema.String, SessionStatus.Info)
export const UpdatePayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Session.Metadata),
  permission: Schema.optional(PermissionV1.Ruleset),
  time: Schema.optional(
    Schema.Struct({
      archived: Schema.optional(Session.ArchivedTimestamp),
    }),
  ),
})
export const ForkPayload = Schema.Struct(Struct.omit(Session.ForkInput.fields, ["sessionID"]))
export const InitPayload = Schema.Struct({
  modelID: ModelV2.ID,
  providerID: ProviderV2.ID,
  messageID: MessageID,
})
export const SummarizePayload = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  auto: Schema.optional(Schema.Boolean),
})
export const PromptPayload = Schema.Struct(Struct.omit(SessionPrompt.PromptInput.fields, ["sessionID"]))
export const CommandPayload = Schema.Struct(Struct.omit(SessionPrompt.CommandInput.fields, ["sessionID"]))
export const ShellPayload = Schema.Struct(Struct.omit(SessionPrompt.ShellInput.fields, ["sessionID"]))
export const RevertPayload = Schema.Struct(Struct.omit(SessionRevert.RevertInput.fields, ["sessionID"]))
export const PermissionResponsePayload = Schema.Struct({
  response: PermissionV1.Reply,
})

export const ContextTrimPayload = Schema.Struct({
  keepMessages: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500)),
  ),
})
export const ContextOpResult = Schema.Struct({
  operation: Schema.Literals(["clear", "trim", "prune"]),
  removedMessages: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  remainingMessages: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  epochReset: Schema.Boolean,
  baselineReinitialized: Schema.String,
  baselineSeq: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})

export const GuardApprovalPayload = Schema.Struct({
  decision: Schema.Literals(["allow_once", "deny", "grant_session", "grant_workspace"]),
})
export const SessionPaths = {
  list: root,
  status: `${root}/status`,
  get: `${root}/:sessionID`,
  children: `${root}/:sessionID/children`,
  subagents: `${root}/:sessionID/subagents`,
  subagentWait: `${root}/:sessionID/subagents/:childSessionID/wait`,
  subagentMessage: `${root}/:sessionID/subagents/:childSessionID/message`,
  todo: `${root}/:sessionID/todo`,
  diff: `${root}/:sessionID/diff`,
  messages: `${root}/:sessionID/message`,
  message: `${root}/:sessionID/message/:messageID`,
  create: root,
  remove: `${root}/:sessionID`,
  update: `${root}/:sessionID`,
  fork: `${root}/:sessionID/fork`,
  abort: `${root}/:sessionID/abort`,
  share: `${root}/:sessionID/share`,
  init: `${root}/:sessionID/init`,
  summarize: `${root}/:sessionID/summarize`,
  contextClear: `${root}/:sessionID/context/clear`,
  contextTrim: `${root}/:sessionID/context/trim`,
  contextPrune: `${root}/:sessionID/context/prune`,
  prompt: `${root}/:sessionID/message`,
  promptAsync: `${root}/:sessionID/prompt_async`,
  command: `${root}/:sessionID/command`,
  guardApproval: "/guard/approval/:approvalID/reply",
  questions: `${root}/:sessionID/question`,
  questionReply: `${root}/:sessionID/question/:requestID/reply`,
  questionReject: `${root}/:sessionID/question/:requestID/reject`,
  shell: `${root}/:sessionID/shell`,
  revert: `${root}/:sessionID/revert`,
  unrevert: `${root}/:sessionID/unrevert`,
  permissions: `${root}/:sessionID/permissions/:permissionID`,
  deleteMessage: `${root}/:sessionID/message/:messageID`,
  deletePart: `${root}/:sessionID/message/:messageID/part/:partID`,
  updatePart: `${root}/:sessionID/message/:messageID/part/:partID`,
} as const

export const SessionApi = HttpApi.make("session")
  .add(
    HttpApiGroup.make("session")
      .add(
        HttpApiEndpoint.get("list", SessionPaths.list, {
          query: ListQuery,
          success: described(Schema.Array(Session.Info), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.list",
            summary: "List sessions",
            description: "Get a list of all OpenCode sessions, sorted by most recently updated.",
          }),
        ),
        HttpApiEndpoint.get("status", SessionPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(StatusMap, "Get session status"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.status",
            summary: "Get session status",
            description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
          }),
        ),
        HttpApiEndpoint.get("get", SessionPaths.get, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Get session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.get",
            summary: "Get session",
            description: "Retrieve detailed information about a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.get("children", SessionPaths.children, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Session.Info), "List of children"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ForbiddenError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.children",
            summary: "Get session children",
            description: "Retrieve child sessions only when the authenticated principal owns the parent Session lineage.",
          }),
        ),
        HttpApiEndpoint.get("subagents", SessionPaths.subagents, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(SubagentStatusV1.ListV1, "Bounded direct child lifecycle projection"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ForbiddenError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.subagents",
            summary: "Inspect direct child Sessions",
            description: "Return bounded owner-checked child status, immutable profile/Attempt pins, and an aggregate count of rows reserving mailbox capacity. Message content and turn authority are not exposed by this projection.",
          }),
        ),
        HttpApiEndpoint.get("subagentWait", SessionPaths.subagentWait, {
          params: { sessionID: SessionID, childSessionID: SessionID },
          query: SubagentWaitQuery,
          success: described(SubagentStatusV1.WaitResultV1, "Wait for a bounded direct child update"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.subagents.wait",
            summary: "Wait for a direct child without cancelling it",
            description: "Wait up to 30 seconds for terminal state, new activity, or timeout. A timeout never cancels the named child.",
          }),
        ),
        HttpApiEndpoint.post("subagentMessage", SessionPaths.subagentMessage, {
          params: { sessionID: SessionID, childSessionID: SessionID },
          payload: SubagentMessagePayload,
          success: described(SubagentMessageResult, "Guarded direct child inbox message outcome"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ForbiddenError, ConflictError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.subagents.message",
            summary: "Queue a message for a direct child Session",
            description: "Appends a bounded queued or explicit follow-up message through HostKernel Guard and a durable Core inbox receipt. Follow-up execution remains unavailable until P1 Guard/lease and P8 recovery acceptance enable the turn-cycle gate.",
          }),
        ),
        HttpApiEndpoint.get("todo", SessionPaths.todo, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Todo.Info), "Todo list"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ForbiddenError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.todo",
            summary: "Get session todos",
            description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
          }),
        ),
        HttpApiEndpoint.get("questions", SessionPaths.questions, {
          params: { sessionID: SessionV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(QuestionV2.Request), "Pending questions for this session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.questions",
            summary: "List pending session questions",
            description: "List pending question.ask prompts for the authenticated session owner.",
          }),
        ),
        HttpApiEndpoint.post("questionReply", SessionPaths.questionReply, {
          params: { sessionID: SessionV2.ID, requestID: QuestionV2.ID },
          query: WorkspaceRoutingQuery,
          payload: QuestionV2.Reply,
          success: HttpApiSchema.NoContent,
          error: [HttpApiError.BadRequest, ApiNotFoundError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.question.reply",
            summary: "Reply to a pending question",
            description: "Answer a question.ask prompt only in its owning session.",
          }),
        ),
        HttpApiEndpoint.post("questionReject", SessionPaths.questionReject, {
          params: { sessionID: SessionV2.ID, requestID: QuestionV2.ID },
          query: WorkspaceRoutingQuery,
          success: HttpApiSchema.NoContent,
          error: [HttpApiError.BadRequest, ApiNotFoundError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.question.reject",
            summary: "Reject a pending question",
            description: "Dismiss a question.ask prompt only in its owning session.",
          }),
        ),
        HttpApiEndpoint.get("diff", SessionPaths.diff, {
          params: { sessionID: SessionID },
          query: DiffQuery,
          success: described(Schema.Array(FileDiffSchema), "Successfully retrieved diff"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.diff",
            summary: "Get message diff",
            description: "Get the file changes (diff) that resulted from a specific user message in the session.",
          }),
        ),
        HttpApiEndpoint.get("messages", SessionPaths.messages, {
          params: { sessionID: SessionID },
          query: MessagesQuery,
          success: described(Schema.Array(SessionV1.WithParts), "List of messages"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.messages",
            summary: "Get session messages",
            description: "Retrieve all messages in a session, including user prompts and AI responses.",
          }),
        ),
        HttpApiEndpoint.get("message", SessionPaths.message, {
          params: { sessionID: SessionID, messageID: MessageID },
          query: WorkspaceRoutingQuery,
          success: described(SessionV1.WithParts, "Message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.message",
            summary: "Get message",
            description: "Retrieve a specific message from a session by its message ID.",
          }),
        ),
        HttpApiEndpoint.post("create", SessionPaths.create, {
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Session.CreateInput],
          success: described(Session.Info, "Successfully created session"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.create",
            summary: "Create session",
            description: "Create a new OpenCode session for interacting with AI assistants and managing conversations.",
          }),
        ),
        HttpApiEndpoint.delete("remove", SessionPaths.remove, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.delete",
            summary: "Delete session",
            description: "Delete a session and permanently remove all associated data, including messages and history.",
          }),
        ),
        HttpApiEndpoint.patch("update", SessionPaths.update, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: UpdatePayload,
          success: described(Session.Info, "Successfully updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ForbiddenError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.update",
            summary: "Update session",
            description: "Update properties of an existing session, such as title or other metadata.",
          }),
        ),
        HttpApiEndpoint.post("fork", SessionPaths.fork, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, ForkPayload],
          success: described(Session.Info, "200"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.fork",
            summary: "Fork session",
            description: "Create a new session by forking an existing session at a specific message point.",
          }),
        ),
        HttpApiEndpoint.post("abort", SessionPaths.abort, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Aborted session"),
          error: [HttpApiError.BadRequest, ForbiddenError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.abort",
            summary: "Abort session",
            description: "Abort an active Session only within the authenticated principal's owner lineage; interruption also closes the owning direct Attempt through its existing cancellation fence.",
          }),
        ),
        HttpApiEndpoint.post("init", SessionPaths.init, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: InitPayload,
          success: described(Schema.Boolean, "200"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.init",
            summary: "Initialize session",
            description:
              "Analyze the current application and create an AGENTS.md file with project-specific agent configurations.",
          }),
        ),
        HttpApiEndpoint.post("share", SessionPaths.share, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Successfully shared session"),
          error: [HttpApiError.InternalServerError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.share",
            summary: "Share session",
            description: "Create a shareable link for a session, allowing others to view the conversation.",
          }),
        ),
        HttpApiEndpoint.delete("unshare", SessionPaths.share, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Successfully unshared session"),
          error: [HttpApiError.InternalServerError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unshare",
            summary: "Unshare session",
            description: "Remove the shareable link for a session, making it private again.",
          }),
        ),
        HttpApiEndpoint.post("summarize", SessionPaths.summarize, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SummarizePayload,
          success: described(Schema.Boolean, "Summarized session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.summarize",
            summary: "Summarize session",
            description: "Generate a concise summary of the session using AI compaction to preserve key information.",
          }),
        ),
        HttpApiEndpoint.post("contextClear", SessionPaths.contextClear, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(ContextOpResult, "Conversation history cleared; a fresh Context Epoch baseline is active"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.context_clear",
            summary: "Clear session context",
            description:
              "Drop the conversation history and start a new Context Epoch with a freshly rendered Baseline System Context. The Session stays alive and the next turn uses the new baseline.",
          }),
        ),
        HttpApiEndpoint.post("contextTrim", SessionPaths.contextTrim, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ContextTrimPayload,
          success: described(ContextOpResult, "Older history trimmed; a fresh Context Epoch baseline is active"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.context_trim",
            summary: "Trim session context",
            description:
              "Bounded, evidence-preserving removal of older conversation history that reclaims context while keeping a coherent recent tail, then starts a new Context Epoch.",
          }),
        ),
        HttpApiEndpoint.post("contextPrune", SessionPaths.contextPrune, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(ContextOpResult, "Stale context sources pruned; a fresh Context Epoch baseline is active"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.context_prune",
            summary: "Prune session context",
            description:
              "Drop stale mid-conversation system messages and pre-compaction rows per the Context Ledger, then start a new Context Epoch.",
          }),
        ),
        HttpApiEndpoint.post("prompt", SessionPaths.prompt, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPayload,
          success: described(SessionV1.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt",
            summary: "Send message",
            description: "Create and send a new message to a session, streaming the AI response.",
          }),
        ),
        HttpApiEndpoint.post("promptAsync", SessionPaths.promptAsync, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPayload,
          success: described(HttpApiSchema.NoContent, "Prompt accepted"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt_async",
            summary: "Send async message",
            description:
              "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
          }),
        ),
        HttpApiEndpoint.post("command", SessionPaths.command, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: CommandPayload,
          success: described(SessionV1.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.command",
            summary: "Send command",
            description: "Send a new command to a session for execution by the AI assistant.",
          }),
        ),
        HttpApiEndpoint.post("shell", SessionPaths.shell, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ShellPayload,
          success: described(SessionV1.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.shell",
            summary: "Run a shell command",
            description: "Run a shell command through Rust Guard and the managed terminal host.",
          }),
        ),
        HttpApiEndpoint.post("guardApproval", SessionPaths.guardApproval, {
          params: { approvalID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: GuardApprovalPayload,
          success: Schema.Boolean,
          error: [HttpApiError.BadRequest, HttpApiError.NotFound, ConflictError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "guard.approval.reply",
            summary: "Reply to a Guard approval request",
            description: "Allow a prepared effect once, deny it, or explicitly save a bounded direct workspace grant. Saving a grant denies this current challenge; a later effect must be freshly prepared.",
          }),
        ),
        HttpApiEndpoint.post("revert", SessionPaths.revert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: RevertPayload,
          success: described(Session.Info, "Updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.revert",
            summary: "Revert message",
            description:
              "Revert is unavailable until session file changes are mediated by Rust Guard and ExecutionHost through files.patch.",
          }),
        ),
        HttpApiEndpoint.post("unrevert", SessionPaths.unrevert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unrevert",
            summary: "Restore reverted messages",
            description:
              "Restoring a reverted session is unavailable until session file changes are mediated by Rust Guard and ExecutionHost through files.patch.",
          }),
        ),
        HttpApiEndpoint.post("permissionRespond", SessionPaths.permissions, {
          params: { sessionID: SessionID, permissionID: PermissionV1.ID },
          query: WorkspaceRoutingQuery,
          payload: PermissionResponsePayload,
          success: described(Schema.Boolean, "Permission processed successfully"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, PermissionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.respond",
            summary: "Respond to permission",
            description: "Approve or deny a permission request from the AI assistant.",
            deprecated: true,
          }),
        ),
        HttpApiEndpoint.delete("deleteMessage", SessionPaths.deleteMessage, {
          params: { sessionID: SessionID, messageID: MessageID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.deleteMessage",
            summary: "Delete message",
            description:
              "Permanently delete a specific message and all of its parts from a session without reverting file changes.",
          }),
        ),
        HttpApiEndpoint.delete("deletePart", SessionPaths.deletePart, {
          params: { sessionID: SessionID, messageID: MessageID, partID: PartID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted part"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "part.delete",
            description: "Delete a part from a message.",
          }),
        ),
        HttpApiEndpoint.patch("updatePart", SessionPaths.updatePart, {
          params: { sessionID: SessionID, messageID: MessageID, partID: PartID },
          query: WorkspaceRoutingQuery,
          payload: SessionV1.Part,
          success: described(SessionV1.Part, "Successfully updated part"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "part.update",
            description: "Update a part in a message.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "session",
          description: "Experimental HttpApi session routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
