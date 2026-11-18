/**
 * Fork-only: a file click opens the file in a Neovim that listens for its folder (see
 * apps/server/src/terminal/neovim.ts), else in the Files surface.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { isAtomCommandInterrupted, runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { shellEnvironment } from "../state/shell";

export interface NeovimOpenTarget {
  /** Absolute path on the server host. */
  readonly path: string;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  /** The thread's worktree, else its project root; a Neovim there takes files outside any cwd. */
  readonly workspace?: string | undefined;
  /** The clicking thread; t3.nvim attaches it for its prompt. */
  readonly threadId?: ThreadId | undefined;
}

/** The server fails when no Neovim listens for the path; then `openViewer` runs. */
export function openInNeovimOrViewer(
  environmentId: EnvironmentId,
  target: NeovimOpenTarget,
  openViewer: () => void,
): void {
  void runAtomCommand(
    appAtomRegistry,
    shellEnvironment.openInEditor,
    {
      environmentId,
      input: {
        cwd: target.path,
        editor: "neovim",
        position: {
          ...(target.line !== undefined ? { line: target.line } : {}),
          ...(target.column !== undefined ? { column: target.column } : {}),
        },
        ...(target.workspace ? { projectRoot: target.workspace } : {}),
        ...(target.threadId ? { threadId: target.threadId } : {}),
      },
    },
    { reportFailure: false },
  ).then((result) => {
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) openViewer();
  });
}
