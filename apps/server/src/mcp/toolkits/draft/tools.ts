import {
  COMPOSER_PROMPT_MAX_LENGTH,
  NonNegativeInt,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ComposerPrompts from "../../../composer/ComposerPrompts.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const ThreadDraft = Schema.Struct({
  threadId: ThreadId,
  prompt: Schema.String,
  revision: NonNegativeInt,
  updatedAt: Schema.NullOr(Schema.String),
});
export type ThreadDraft = typeof ThreadDraft.Type;

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ComposerPrompts.ComposerPrompts,
  ],
};

const ThreadDraftGetTool = Tool.make("t3_thread_draft_get", {
  ...shared,
  description:
    "Read a thread's unsent composer prompt. No draft: empty `prompt`, `revision` 0, null `updatedAt`.",
  parameters: Schema.Struct({ threadId: ThreadId }),
  success: ThreadDraft,
})
  .annotate(Tool.Title, "Read a thread's draft")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromThreads);

const ThreadDraftSetTool = Tool.make("t3_thread_draft_set", {
  ...shared,
  description:
    "Replace a thread's unsent composer prompt in every open client. Empty `prompt` clears it. With `baseRevision`, writes only if the draft is still at that revision; otherwise `accepted` is false and the current draft comes back.",
  parameters: Schema.Struct({
    threadId: ThreadId,
    prompt: Schema.String.check(Schema.isMaxLength(COMPOSER_PROMPT_MAX_LENGTH)),
    baseRevision: Schema.optionalKey(NonNegativeInt),
  }),
  success: Schema.Struct({ ...ThreadDraft.fields, accepted: Schema.Boolean }),
})
  .annotate(Tool.Title, "Set a thread's draft")
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromThreads);

export const ThreadDraftToolkit = Toolkit.make(ThreadDraftGetTool, ThreadDraftSetTool);
