// @effect-diagnostics nodeBuiltinImport:off -- a fake Neovim on a unix socket.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  decodeMsgpackValue,
  defaultNeovimSocketDir,
  encodeMsgpackValue,
  findNeovimSocketForPath,
  neovimSocketPath,
  openInNeovim,
} from "./neovim.ts";

describe("msgpack", () => {
  it("round-trips the values Neovim RPC uses", () => {
    const value = [
      0,
      1,
      "nvim_exec_lua",
      [
        "x".repeat(40),
        ["/a/b.ts", 12, -3, 300, -40_000, 2 ** 40, 1.5, true, false, null],
        { key: "value" },
        "ü".repeat(200),
      ],
    ];
    expect(decodeMsgpackValue(encodeMsgpackValue(value))).toEqual({
      value,
      offset: encodeMsgpackValue(value).length,
    });
  });
});

describe("neovimSocketPath", () => {
  it("is short, stable and unique per home and terminal", () => {
    const socketDir = defaultNeovimSocketDir("darwin") ?? "/tmp/t3-nvim-501";
    const path = neovimSocketPath({
      socketDir,
      baseDir: "/Users/someone/.t3-fork",
      threadId: "a-very-long-thread-id-0123456789abcdef",
      terminalId: "terminal-0123456789",
    });
    expect(path.length).toBeLessThan(104);
    expect(
      neovimSocketPath({
        socketDir,
        baseDir: "/Users/someone/.t3-fork",
        threadId: "a-very-long-thread-id-0123456789abcdef",
        terminalId: "terminal-0123456789",
      }),
    ).toBe(path);
    expect(
      neovimSocketPath({
        socketDir,
        baseDir: "/Users/someone/.t3",
        threadId: "a-very-long-thread-id-0123456789abcdef",
        terminalId: "terminal-0123456789",
      }),
    ).not.toBe(path);
  });
});

/** Answers nvim_exec_lua like Neovim: getcwd lookups return `cwd`, opens are recorded. */
async function fakeNeovim(socket: string, cwd: string) {
  const calls: unknown[][] = [];
  const server = NodeNet.createServer((connection) => {
    connection.on("data", (chunk) => {
      const { value } = decodeMsgpackValue(chunk);
      const [, msgid, , params] = value as [number, number, string, [string, unknown[]]];
      const isCwd = params[0].includes("getcwd");
      if (!isCwd) calls.push(params[1]);
      connection.write(encodeMsgpackValue([1, msgid, null, isCwd ? cwd : true]));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return { calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("openInNeovim", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("waits for a Neovim that is still starting, then opens the file at the position", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "nv-"));
    cleanups.push(() => NodeFSP.rm(dir, { recursive: true, force: true }));
    const socket = NodePath.join(dir, "s.sock");
    // Neovim is not listening yet when the open starts.
    const opening = openInNeovim({ socket, path: "/p/a.ts", line: 3, column: 7, waitMs: 5_000 });
    const nvim = await fakeNeovim(socket, "/p");
    cleanups.push(nvim.close);
    await opening;
    expect(nvim.calls).toEqual([["/p/a.ts", 3, 7]]);
  });

  it("fails when no Neovim listens before the deadline", async () => {
    await expect(
      openInNeovim({ socket: "/tmp/t3-nvim-missing.sock", path: "/p/a.ts", waitMs: 200 }),
    ).rejects.toThrow();
  });

  it("finds the Neovim of this home whose cwd holds the file", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "nv-"));
    cleanups.push(() => NodeFSP.rm(dir, { recursive: true, force: true }));
    const socketFor = (baseDir: string, terminalId: string) =>
      neovimSocketPath({ socketDir: dir, baseDir, threadId: "t", terminalId });
    const outer = await fakeNeovim(socketFor("/home", "a"), "/repo");
    const inner = await fakeNeovim(socketFor("/home", "b"), "/repo/pkg");
    const other = await fakeNeovim(socketFor("/other-home", "c"), "/repo/pkg/src");
    cleanups.push(outer.close, inner.close, other.close);
    expect(
      await findNeovimSocketForPath({
        socketDir: dir,
        baseDir: "/home",
        targetPath: "/repo/pkg/src/x.ts",
      }),
    ).toBe(socketFor("/home", "b"));
  });
});
