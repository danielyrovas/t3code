import { assert, it } from "@effect/vitest";
import { type ComposerPromptEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ComposerPrompts from "./ComposerPrompts.ts";

const threadId = ThreadId.make("thread-1");

it.effect("revisions guard writes, and a new subscriber gets a snapshot then each change", () =>
  Effect.gen(function* () {
    const prompts = yield* ComposerPrompts.make;

    const first = yield* prompts.set({
      threadId,
      prompt: "a",
      source: "web",
      originClientId: "tab",
    });
    assert.deepStrictEqual([first.accepted, first.prompt.revision], [true, 1]);
    const unchanged = yield* prompts.set({ threadId, prompt: "a", baseRevision: 1, source: "web" });
    assert.deepStrictEqual([unchanged.accepted, unchanged.prompt.revision], [true, 1]);

    const stale = yield* prompts.set({ threadId, prompt: "b", baseRevision: 0, source: "cli" });
    assert.deepStrictEqual(
      [stale.accepted, stale.prompt.prompt, stale.prompt.revision],
      [false, "a", 1],
    );
    const missing = yield* prompts.set({
      threadId: ThreadId.make("other"),
      prompt: "x",
      baseRevision: 3,
      source: "cli",
    });
    assert.deepStrictEqual([missing.accepted, missing.prompt.revision], [false, 0]);

    const queue = yield* Queue.unbounded<ComposerPromptEvent>();
    yield* prompts.events.pipe(
      Stream.runForEach((event) => Queue.offer(queue, event)),
      Effect.forkScoped,
    );
    // The snapshot is read after subscribing, so later writes always arrive.
    const snapshot = yield* Queue.take(queue);
    yield* prompts.set({ threadId, prompt: "b", baseRevision: 1, source: "cli" });
    // Clearing is a change like any other, so clients clear their composer.
    yield* prompts.set({ threadId, prompt: "", source: "cli" });
    const received = [snapshot, yield* Queue.take(queue), yield* Queue.take(queue)];

    assert.deepStrictEqual(
      received.map((event) =>
        event.type === "snapshot"
          ? event.prompts.map(({ prompt, revision, originClientId }) => ({
              prompt,
              revision,
              originClientId,
            }))
          : {
              prompt: event.prompt.prompt,
              revision: event.prompt.revision,
              source: event.prompt.source,
            },
      ),
      [
        [{ prompt: "a", revision: 1, originClientId: "tab" }],
        { prompt: "b", revision: 2, source: "cli" },
        { prompt: "", revision: 3, source: "cli" },
      ],
    );
    assert.strictEqual((yield* prompts.get(threadId))?.prompt, "");
  }).pipe(Effect.scoped),
);
