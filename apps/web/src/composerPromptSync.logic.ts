import type {
  ComposerPrompt,
  ComposerPromptEvent,
  ComposerReportPromptInput,
  ComposerReportPromptResult,
  ThreadId,
} from "@t3tools/contracts";

const COMPOSER_PROMPT_REPORT_DEBOUNCE_MS = 300;

export interface ComposerPromptSyncOptions {
  readonly clientId: string;
  /** The local prompt of each synced thread; threads without a draft may be left out. */
  readonly readLocalPrompts: () => ReadonlyMap<ThreadId, string>;
  readonly applyLocalPrompt: (threadId: ThreadId, prompt: string) => void;
  /** Resolves null when the report did not reach the server. */
  readonly report: (input: ComposerReportPromptInput) => Promise<ComposerReportPromptResult | null>;
  readonly debounceMs?: number;
}

interface ServerState {
  readonly revision: number;
  readonly prompt: string;
}

const EMPTY: ServerState = { revision: 0, prompt: "" };

/**
 * Keeps one environment's thread drafts in step with the server copy. The
 * server copy is the base: a local prompt that differs from it is reported
 * against its revision, and a newer server prompt from anyone else replaces the
 * local one. A conflicting report loses and takes the server's prompt.
 */
export function createComposerPromptSync(options: ComposerPromptSyncOptions) {
  const debounceMs = options.debounceMs ?? COMPOSER_PROMPT_REPORT_DEBOUNCE_MS;
  /** Null until the first snapshot: nothing is reported before the base is known. */
  let server: Map<ThreadId, ServerState> | null = null;
  const timers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<ThreadId>();
  let disposed = false;

  const base = (threadId: ThreadId) => server?.get(threadId) ?? EMPTY;
  const localPrompt = (threadId: ThreadId) => options.readLocalPrompts().get(threadId) ?? "";

  const cancel = (threadId: ThreadId) => {
    const timer = timers.get(threadId);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(threadId);
  };

  const accept = (prompt: ComposerPrompt) => {
    if (server === null || prompt.revision < base(prompt.threadId).revision) return false;
    server.set(prompt.threadId, { revision: prompt.revision, prompt: prompt.prompt });
    return true;
  };

  const applyServer = (threadId: ThreadId) => {
    cancel(threadId);
    const { prompt } = base(threadId);
    if (localPrompt(threadId) !== prompt) options.applyLocalPrompt(threadId, prompt);
  };

  const flush = (threadId: ThreadId) => {
    timers.delete(threadId);
    if (disposed || server === null || inFlight.has(threadId)) return;
    const prompt = localPrompt(threadId);
    const { revision } = base(threadId);
    if (prompt === base(threadId).prompt) return;
    inFlight.add(threadId);
    void options
      .report({ threadId, prompt, baseRevision: revision, clientId: options.clientId })
      .then((result) => {
        inFlight.delete(threadId);
        if (disposed || result === null) return;
        accept(result.prompt);
        if (!result.accepted) {
          applyServer(threadId);
          return;
        }
        // Typing that landed while the report was out goes in the next one.
        if (localPrompt(threadId) !== base(threadId).prompt) schedule(threadId);
      });
  };

  const schedule = (threadId: ThreadId) => {
    cancel(threadId);
    timers.set(
      threadId,
      setTimeout(() => flush(threadId), debounceMs),
    );
  };

  return {
    /** Call with the threads whose local draft may have changed. */
    localChanged(threadIds: Iterable<ThreadId>): void {
      if (disposed || server === null) return;
      const local = options.readLocalPrompts();
      for (const threadId of threadIds) {
        if ((local.get(threadId) ?? "") !== base(threadId).prompt) schedule(threadId);
        else cancel(threadId);
      }
    },

    serverEvent(event: ComposerPromptEvent): void {
      if (disposed) return;
      if (event.type === "snapshot") {
        const previous = server;
        server = new Map(
          event.prompts.map((prompt) => [
            prompt.threadId,
            { revision: prompt.revision, prompt: prompt.prompt },
          ]),
        );
        const local = options.readLocalPrompts();
        const threadIds = new Set([...local.keys(), ...server.keys()]);
        for (const threadId of threadIds) {
          const prompt = local.get(threadId) ?? "";
          const stored = server.get(threadId);
          if (prompt === (stored?.prompt ?? "")) continue;
          // Edited here while disconnected, or a draft a restarted server forgot: report it.
          const editedHere =
            previous === null
              ? stored === undefined
              : prompt !== (previous.get(threadId) ?? EMPTY).prompt;
          if (editedHere) schedule(threadId);
          else applyServer(threadId);
        }
        return;
      }
      const { prompt } = event;
      if (!accept(prompt)) return;
      if (prompt.originClientId === options.clientId) return;
      applyServer(prompt.threadId);
    },

    dispose(): void {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

export type ComposerPromptSync = ReturnType<typeof createComposerPromptSync>;
