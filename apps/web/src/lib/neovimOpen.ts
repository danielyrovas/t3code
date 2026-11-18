/**
 * Fork-only: file links open in the thread's embedded Neovim when the server offers Neovim.
 *
 * The chat view of the active thread registers a handler; file-link and diff clicks call
 * {@link openInThreadNeovim} and fall back to the Files surface when it returns false.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { msg, useMessages } from "gt-react";
import { useEffect } from "react";

import { useStableCallback } from "../hooks/useStableCallback";
import { serverEnvironment } from "../state/server";
import { shellEnvironment } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { toastManager } from "../components/ui/toast";

export interface NeovimOpenTarget {
  /** Absolute path on the server host. */
  readonly path: string;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
}

type NeovimOpenHandler = (target: NeovimOpenTarget) => boolean;

const handlers = new Map<string, NeovimOpenHandler>();

/** Makes `handler` take this thread's file opens; returns the unregister function. */
export function registerNeovimOpenHandler(
  threadRef: ScopedThreadRef,
  handler: NeovimOpenHandler,
): () => void {
  const threadKey = scopedThreadKey(threadRef);
  handlers.set(threadKey, handler);
  return () => {
    if (handlers.get(threadKey) === handler) handlers.delete(threadKey);
  };
}

/** Opens the file in the thread's Neovim. False when that thread cannot, so the caller falls back. */
export function openInThreadNeovim(threadRef: ScopedThreadRef, target: NeovimOpenTarget): boolean {
  return handlers.get(scopedThreadKey(threadRef))?.(target) ?? false;
}

export function canOpenInThreadNeovim(threadRef: ScopedThreadRef | null | undefined): boolean {
  return threadRef ? handlers.has(scopedThreadKey(threadRef)) : false;
}

/**
 * Registers the Neovim file opener for `threadRef`. `showNeovim` shows the thread's Neovim
 * surface (it launches one when there is none) and returns its terminal id; the server waits
 * for a new Neovim's socket.
 */
export function useNeovimFileOpener(
  threadRef: ScopedThreadRef | null,
  showNeovim: () => string | null,
): void {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(threadRef?.environmentId ?? null),
  );
  const available = serverConfig?.availableEditors.includes("neovim") === true;
  const resolve = useMessages();

  const open = useStableCallback((target: NeovimOpenTarget): boolean => {
    if (!threadRef) return false;
    const terminalId = showNeovim();
    if (!terminalId) return false;
    void openInEditor({
      environmentId: threadRef.environmentId,
      input: {
        cwd: target.path,
        editor: "neovim",
        position: {
          ...(target.line !== undefined ? { line: target.line } : {}),
          ...(target.column !== undefined ? { column: target.column } : {}),
        },
        terminal: { threadId: threadRef.threadId, terminalId },
      },
    }).then((result) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      toastManager.add({
        type: "error",
        title: resolve(msg("Could not open in {editor}", { editor: "Neovim" })),
        description: target.path,
      });
    });
    return true;
  });

  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this thread's opener for file-link clicks outside the chat view
  useEffect(() => {
    if (environmentId === null || threadId === null || !available) return;
    return registerNeovimOpenHandler({ environmentId, threadId }, open);
  }, [environmentId, threadId, available, open]);
}
