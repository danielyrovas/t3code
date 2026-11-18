import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const COMPOSER_PROMPT_MAX_LENGTH = 1_000_000;

const Prompt = Schema.String.check(Schema.isMaxLength(COMPOSER_PROMPT_MAX_LENGTH));
const ClientId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const ComposerPromptSource = Schema.Literals(["web", "cli"]);
export type ComposerPromptSource = typeof ComposerPromptSource.Type;

/** A thread's unsent composer text, held in server memory so other clients can edit it. */
export const ComposerPrompt = Schema.Struct({
  threadId: ThreadId,
  prompt: Prompt,
  revision: NonNegativeInt,
  updatedAt: IsoDateTime,
  source: ComposerPromptSource,
  originClientId: Schema.optionalKey(ClientId),
});
export type ComposerPrompt = typeof ComposerPrompt.Type;

export const ComposerReportPromptInput = Schema.Struct({
  threadId: ThreadId,
  prompt: Prompt,
  /** Write only when the stored revision is still this one. */
  baseRevision: Schema.optionalKey(NonNegativeInt),
  /** Comes back as `originClientId` so the reporting client can skip its own echo. */
  clientId: Schema.optionalKey(ClientId),
});
export type ComposerReportPromptInput = typeof ComposerReportPromptInput.Type;

/** `prompt` is the stored draft: the new one when accepted, the one that won otherwise. */
export const ComposerReportPromptResult = Schema.Struct({
  accepted: Schema.Boolean,
  prompt: ComposerPrompt,
});
export type ComposerReportPromptResult = typeof ComposerReportPromptResult.Type;

/** Every subscription starts with a snapshot of all stored drafts. */
export const ComposerPromptEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    prompts: Schema.Array(ComposerPrompt),
  }),
  Schema.Struct({
    type: Schema.Literal("composerPromptUpdated"),
    prompt: ComposerPrompt,
  }),
]);
export type ComposerPromptEvent = typeof ComposerPromptEvent.Type;
