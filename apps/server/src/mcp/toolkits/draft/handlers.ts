import type { ComposerPrompt, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ComposerPrompts from "../../../composer/ComposerPrompts.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, threadNotFound, unavailable } from "../../threadAccess.ts";
import { type ThreadDraft, ThreadDraftToolkit } from "./tools.ts";

const toThreadDraft = (threadId: ThreadId, stored: ComposerPrompt | undefined): ThreadDraft =>
  stored === undefined || stored.revision === 0
    ? { threadId, prompt: "", revision: 0, updatedAt: null }
    : { threadId, prompt: stored.prompt, revision: stored.revision, updatedAt: stored.updatedAt };

const requireThread = Effect.fn("ThreadDraftTools.requireThread")(function* (threadId: ThreadId) {
  const { scope, threads } = yield* readCaller();
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
  if (shell === null || shell.deletedAt !== null) {
    return yield* threadNotFound(threads, scope, threadId, `No thread \`${threadId}\`.`);
  }
});

export const layer = McpToolAccess.toLayer(ThreadDraftToolkit, {
  t3_thread_draft_get: McpToolAccess.reads(({ threadId }) =>
    Effect.gen(function* () {
      yield* requireThread(threadId);
      const prompts = yield* ComposerPrompts.ComposerPrompts;
      return toThreadDraft(threadId, yield* prompts.get(threadId));
    }),
  ),
  t3_thread_draft_set: McpToolAccess.writesThreads(
    ({ threadId }) => [threadId],
    ({ threadId, prompt, baseRevision }) =>
      Effect.gen(function* () {
        yield* requireThread(threadId);
        const prompts = yield* ComposerPrompts.ComposerPrompts;
        const result = yield* prompts.set({ threadId, prompt, baseRevision, source: "cli" });
        return { ...toThreadDraft(threadId, result.prompt), accepted: result.accepted };
      }),
  ),
});
