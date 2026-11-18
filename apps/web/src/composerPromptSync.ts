import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import { useComposerDraftStore } from "./composerDraftStore";
import { type ComposerPromptSync, createComposerPromptSync } from "./composerPromptSync.logic";
import { connectionAtomRuntime } from "./connection/runtime";
import { randomUUID } from "./lib/utils";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentPresentations } from "./state/presentation";
import { environmentSession, sessionHasScope } from "./state/session";

const composerPromptEvents = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:composer:prompts",
  tag: WS_METHODS.subscribeComposerPrompts,
  // Every event matters, and a cached snapshot must not replay over newer local drafts.
  transform: (stream) => stream.pipe(Stream.rechunk(1)),
  idleTtlMs: 0,
});

const reportComposerPrompt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:composer:report-prompt",
  tag: WS_METHODS.composerReportPrompt,
});

const syncTargetsAtom = Atom.make((get) => {
  const targets: Array<EnvironmentId> = [];
  for (const [environmentId, config] of get(environmentPresentations.serverConfigsAtom)) {
    if (config.environment.capabilities.composerPromptSync !== true) continue;
    const session = get(environmentSession.sessionStateAtom(environmentId));
    if (sessionHasScope(session, AuthOrchestrationOperateScope)) targets.push(environmentId);
  }
  return targets;
}).pipe(Atom.withLabel("composer-prompt-sync-targets"));

/** Saved threads only: a draft thread's composer is keyed by its draft id and stays local. */
function readLocalPrompts(environmentId: EnvironmentId): Map<ThreadId, string> {
  const state = useComposerDraftStore.getState();
  const prompts = new Map<ThreadId, string>();
  for (const [key, draft] of Object.entries(state.draftsByThreadKey)) {
    if (state.draftThreadsByThreadKey[key]) continue;
    const ref = parseScopedThreadKey(key);
    if (ref?.environmentId === environmentId) prompts.set(ref.threadId, draft.prompt);
  }
  return prompts;
}

function isDraftThread(environmentId: EnvironmentId, threadId: ThreadId): boolean {
  return Object.values(useComposerDraftStore.getState().draftThreadsByThreadKey).some(
    (draft) => draft.environmentId === environmentId && draft.threadId === threadId,
  );
}

function startEnvironmentSync(environmentId: EnvironmentId, clientId: string) {
  const sync = createComposerPromptSync({
    clientId,
    readLocalPrompts: () => readLocalPrompts(environmentId),
    applyLocalPrompt: (threadId, prompt) => {
      if (isDraftThread(environmentId, threadId)) return;
      useComposerDraftStore.getState().setPrompt(scopeThreadRef(environmentId, threadId), prompt);
    },
    report: async (input) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        reportComposerPrompt,
        { environmentId, input },
        { reportFailure: false },
      );
      return result._tag === "Success" ? result.value : null;
    },
  });
  const unsubscribe = appAtomRegistry.subscribe(
    composerPromptEvents({ environmentId, input: {} }),
    (result) => {
      if (AsyncResult.isSuccess(result)) sync.serverEvent(result.value);
    },
    { immediate: true },
  );
  return {
    sync,
    stop: () => {
      unsubscribe();
      sync.dispose();
    },
  };
}

/** Mirrors saved threads' composer prompts to their servers, so editors such as t3.nvim share them. */
export function startComposerPromptSync(): () => void {
  const clientId = randomUUID();
  const running = new Map<EnvironmentId, { sync: ComposerPromptSync; stop: () => void }>();
  const stopTargets = appAtomRegistry.subscribe(
    syncTargetsAtom,
    (targets) => {
      for (const [environmentId, entry] of running) {
        if (targets.includes(environmentId)) continue;
        entry.stop();
        running.delete(environmentId);
      }
      for (const environmentId of targets) {
        if (!running.has(environmentId)) {
          running.set(environmentId, startEnvironmentSync(environmentId, clientId));
        }
      }
    },
    { immediate: true },
  );
  const stopDrafts = useComposerDraftStore.subscribe((state, previous) => {
    if (state.draftsByThreadKey === previous.draftsByThreadKey) return;
    const changed = new Map<EnvironmentId, Array<ThreadId>>();
    for (const key of new Set([
      ...Object.keys(state.draftsByThreadKey),
      ...Object.keys(previous.draftsByThreadKey),
    ])) {
      if (state.draftsByThreadKey[key] === previous.draftsByThreadKey[key]) continue;
      const ref = parseScopedThreadKey(key);
      if (ref === null || !running.has(ref.environmentId)) continue;
      const threadIds = changed.get(ref.environmentId) ?? [];
      threadIds.push(ref.threadId);
      changed.set(ref.environmentId, threadIds);
    }
    for (const [environmentId, threadIds] of changed) {
      running.get(environmentId)?.sync.localChanged(threadIds);
    }
  });
  return () => {
    stopTargets();
    stopDrafts();
    for (const entry of running.values()) entry.stop();
    running.clear();
  };
}
