import {
  type ComposerPrompt,
  type ComposerReportPromptInput,
  type ComposerReportPromptResult,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { createComposerPromptSync } from "./composerPromptSync.logic";

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

const stored = (
  threadId: ThreadId,
  prompt: string,
  revision: number,
  originClientId?: string,
): ComposerPrompt => ({
  threadId,
  prompt,
  revision,
  updatedAt: "2026-11-18T00:00:00.000Z",
  source: originClientId === undefined ? "cli" : "web",
  ...(originClientId === undefined ? {} : { originClientId }),
});

function setup(initial: Record<string, string> = {}) {
  vi.useFakeTimers();
  const local = new Map(Object.entries(initial) as Array<[ThreadId, string]>);
  const reports: Array<{
    readonly input: ComposerReportPromptInput;
    readonly resolve: (result: ComposerReportPromptResult | null) => void;
  }> = [];
  const sync = createComposerPromptSync({
    clientId: "me",
    readLocalPrompts: () => local,
    applyLocalPrompt: (threadId, prompt) => {
      local.set(threadId, prompt);
      sync.localChanged([threadId]);
    },
    report: (input) =>
      new Promise((resolve) => {
        reports.push({ input, resolve });
      }),
  });
  const type = (threadId: ThreadId, prompt: string) => {
    local.set(threadId, prompt);
    sync.localChanged([threadId]);
  };
  return { sync, local, reports, type };
}

it("reports debounced typing against the server revision and skips its own echo", async () => {
  const { sync, local, reports, type } = setup();
  type(threadA, "early");
  sync.serverEvent({ type: "snapshot", prompts: [stored(threadA, "early", 2)] });
  vi.advanceTimersByTime(1_000);
  // Typed before the base was known, and already equal to it.
  expect(reports).toHaveLength(0);

  type(threadA, "h");
  type(threadA, "hi");
  vi.advanceTimersByTime(299);
  expect(reports).toHaveLength(0);
  vi.advanceTimersByTime(1);
  expect(reports.map((report) => report.input)).toEqual([
    { threadId: threadA, prompt: "hi", baseRevision: 2, clientId: "me" },
  ]);

  sync.serverEvent({ type: "composerPromptUpdated", prompt: stored(threadA, "hi", 3, "me") });
  type(threadA, "hi!");
  reports[0]!.resolve({ accepted: true, prompt: stored(threadA, "hi", 3, "me") });
  await vi.runAllTimersAsync();
  expect(local.get(threadA)).toBe("hi!");
  expect(reports[1]?.input).toMatchObject({ prompt: "hi!", baseRevision: 3 });
  vi.useRealTimers();
});

it("applies other clients' prompts, drops older revisions, and takes the server's on conflict", async () => {
  const { sync, local, reports, type } = setup({ [threadA]: "web" });
  sync.serverEvent({ type: "snapshot", prompts: [stored(threadA, "web", 1)] });

  type(threadA, "web edit");
  sync.serverEvent({ type: "composerPromptUpdated", prompt: stored(threadA, "nvim", 2) });
  expect(local.get(threadA)).toBe("nvim");
  vi.advanceTimersByTime(1_000);
  expect(reports).toHaveLength(0);

  sync.serverEvent({ type: "composerPromptUpdated", prompt: stored(threadA, "old", 1) });
  expect(local.get(threadA)).toBe("nvim");
  sync.serverEvent({ type: "composerPromptUpdated", prompt: stored(threadA, "", 3) });
  expect(local.get(threadA)).toBe("");

  type(threadA, "mine");
  vi.advanceTimersByTime(300);
  reports[0]!.resolve({ accepted: false, prompt: stored(threadA, "theirs", 4) });
  await vi.runAllTimersAsync();
  expect(local.get(threadA)).toBe("theirs");
  expect(reports).toHaveLength(1);
  vi.useRealTimers();
});

it("on reconnect reports drafts a restarted server lost and local edits made while away", () => {
  const { sync, local, reports } = setup({ [threadA]: "kept", [threadB]: "lost" });
  sync.serverEvent({ type: "snapshot", prompts: [stored(threadA, "server", 5)] });
  // First snapshot: the server's copy wins where it has one.
  expect(local.get(threadA)).toBe("server");
  vi.advanceTimersByTime(300);
  expect(reports.map((report) => report.input)).toEqual([
    { threadId: threadB, prompt: "lost", baseRevision: 0, clientId: "me" },
  ]);

  sync.dispose();
  const next = setup({ [threadA]: "a" });
  next.sync.serverEvent({ type: "snapshot", prompts: [stored(threadA, "a", 1)] });
  next.type(threadA, "typed offline");
  // A restarted server starts over at revision 0 and has none of it.
  next.sync.serverEvent({ type: "snapshot", prompts: [] });
  vi.advanceTimersByTime(300);
  expect(next.reports.map((report) => report.input)).toEqual([
    { threadId: threadA, prompt: "typed offline", baseRevision: 0, clientId: "me" },
  ]);
  next.sync.dispose();
  vi.useRealTimers();
});
