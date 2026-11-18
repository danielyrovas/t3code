import type { TerminalLaunchCommand } from "@t3tools/contracts";

import type { RightPanelSurface } from "../rightPanelStore";

/**
 * A login fish loads the user's PATH and tool shims (mise) before it becomes nvim. The server
 * sets T3_NVIM_SOCKET for each start, so T3 can open files in this nvim.
 */
export const NEOVIM_TERMINAL_COMMAND: TerminalLaunchCommand = {
  file: "fish",
  args: [
    "-l",
    "-c",
    "if set -q T3_NVIM_SOCKET; exec nvim --listen $T3_NVIM_SOCKET; else; exec nvim; end",
  ],
};

export type NeovimSurface = Extract<RightPanelSurface, { kind: "terminal" }> & {
  launch: "neovim";
};

export function isNeovimSurface(
  surface: RightPanelSurface | null | undefined,
): surface is NeovimSurface {
  return surface?.kind === "terminal" && surface.launch === "neovim";
}

/** Only the surface's first terminal runs Neovim; splits beside it are ordinary shells. */
export function terminalSurfaceLaunchCommand(
  surface: Extract<RightPanelSurface, { kind: "terminal" }>,
  terminalId: string,
): TerminalLaunchCommand | undefined {
  return surface.launch === "neovim" && terminalId === surface.resourceId
    ? NEOVIM_TERMINAL_COMMAND
    : undefined;
}
