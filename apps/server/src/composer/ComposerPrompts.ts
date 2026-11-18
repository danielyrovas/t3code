import type {
  ComposerPrompt,
  ComposerPromptEvent,
  ComposerPromptSource,
  ComposerReportPromptResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

export interface ComposerPromptWrite {
  readonly threadId: ThreadId;
  readonly prompt: string;
  /** Write only when the stored revision is still this one; a missing draft is revision 0. */
  readonly baseRevision?: number | undefined;
  readonly source: ComposerPromptSource;
  readonly originClientId?: string | undefined;
}

/**
 * Each thread's unsent composer text, so an editor outside the web client can
 * read and change it. In memory only: clients report their drafts again after a
 * restart.
 */
export class ComposerPrompts extends Context.Service<
  ComposerPrompts,
  {
    readonly get: (threadId: ThreadId) => Effect.Effect<ComposerPrompt | undefined>;
    readonly set: (input: ComposerPromptWrite) => Effect.Effect<ComposerReportPromptResult>;
    /** A snapshot of every stored draft, then each change. */
    readonly events: Stream.Stream<ComposerPromptEvent>;
  }
>()("t3/composer/ComposerPrompts") {}

const emptyPrompt = (threadId: ThreadId, updatedAt: string): ComposerPrompt => ({
  threadId,
  prompt: "",
  revision: 0,
  updatedAt,
  source: "web",
});

export const make = Effect.gen(function* () {
  const prompts = yield* SynchronizedRef.make(new Map<ThreadId, ComposerPrompt>());
  const changes = yield* PubSub.unbounded<ComposerPrompt>();

  const get: ComposerPrompts["Service"]["get"] = (threadId) =>
    SynchronizedRef.get(prompts).pipe(Effect.map((map) => map.get(threadId)));

  const set: ComposerPrompts["Service"]["set"] = Effect.fn("ComposerPrompts.set")(
    function* (input) {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      // Publishing under the lock keeps events in revision order.
      return yield* SynchronizedRef.modifyEffect(prompts, (map) =>
        Effect.gen(function* () {
          const current = map.get(input.threadId);
          const revision = current?.revision ?? 0;
          if (input.baseRevision !== undefined && input.baseRevision !== revision) {
            const result: ComposerReportPromptResult = {
              accepted: false,
              prompt: current ?? emptyPrompt(input.threadId, updatedAt),
            };
            return [result, map] as const;
          }
          if (current !== undefined && current.prompt === input.prompt) {
            return [{ accepted: true, prompt: current }, map] as const;
          }
          const next: ComposerPrompt = {
            threadId: input.threadId,
            prompt: input.prompt,
            revision: revision + 1,
            updatedAt,
            source: input.source,
            ...(input.originClientId === undefined ? {} : { originClientId: input.originClientId }),
          };
          yield* PubSub.publish(changes, next);
          return [
            { accepted: true, prompt: next },
            new Map(map).set(input.threadId, next),
          ] as const;
        }),
      );
    },
  );

  const events: Stream.Stream<ComposerPromptEvent> = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      const snapshot = yield* SynchronizedRef.get(prompts);
      const initial: ComposerPromptEvent = { type: "snapshot", prompts: [...snapshot.values()] };
      return Stream.concat(
        Stream.succeed(initial),
        Stream.fromSubscription(subscription).pipe(
          Stream.filter(
            (prompt) => prompt.revision > (snapshot.get(prompt.threadId)?.revision ?? 0),
          ),
          Stream.map((prompt): ComposerPromptEvent => ({ type: "composerPromptUpdated", prompt })),
        ),
      );
    }),
  );

  return ComposerPrompts.of({ get, set, events });
});

export const layer = Layer.effect(ComposerPrompts, make);
