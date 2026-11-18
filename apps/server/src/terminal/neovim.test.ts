// @effect-diagnostics nodeBuiltinImport:off -- a fake Neovim on a unix socket.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  decodeMsgpackValue,
  encodeMsgpackValue,
  findNeovimSocketForPath,
  homePrefix,
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

/** Answers getcwd like Neovim and records other Lua calls' arguments; never answers when `cwd` is null. */
async function fakeNeovim(socket: string, cwd: string | null, calls: unknown[][] = []) {
  const server = NodeNet.createServer((connection) => {
    connection.on("data", (chunk) => {
      if (cwd === null) return;
      const [, msgid, , [lua, args]] = decodeMsgpackValue(chunk).value as [
        number,
        number,
        string,
        [string, unknown[]],
      ];
      const isCwd = lua.includes("getcwd");
      if (!isCwd) calls.push(args);
      connection.write(encodeMsgpackValue([1, msgid, null, isCwd ? cwd : true]));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("findNeovimSocketForPath", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("picks the deepest Neovim whose cwd holds the file, else the thread workspace", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "nv-"));
    cleanups.push(() => NodeFSP.rm(dir, { recursive: true, force: true }));
    const socketFor = (baseDir: string, name: string) =>
      NodePath.join(dir, `${homePrefix(baseDir)}${name}.sock`);
    cleanups.push(
      await fakeNeovim(socketFor("/home", "outer"), "/repo"),
      await fakeNeovim(socketFor("/home", "inner"), "/repo/pkg"),
      await fakeNeovim(socketFor("/home", "hung"), null),
      await fakeNeovim(socketFor("/other-home", "other"), "/repo/pkg/src"),
    );
    // A socket file nobody listens on, as a crashed Neovim leaves behind.
    await NodeFSP.writeFile(socketFor("/home", "stale"), "");

    const find = (targetPath: string, workspace?: string) =>
      findNeovimSocketForPath({ socketDir: dir, baseDir: "/home", targetPath, workspace });
    expect(await find("/repo/pkg/src/x.ts")).toBe(socketFor("/home", "inner"));
    expect(await find("/repo/a.ts", "/repo/pkg")).toBe(socketFor("/home", "outer"));
    expect(await find("/etc/hosts", "/repo/pkg/src")).toBe(socketFor("/home", "inner"));
    expect(await find("/etc/hosts")).toBeNull();
    expect(await find("/etc/hosts", "/elsewhere")).toBeNull();
  });

  it("opens the file at its position and passes the thread to t3.nvim", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "nv-"));
    cleanups.push(() => NodeFSP.rm(dir, { recursive: true, force: true }));
    const socket = NodePath.join(dir, "s.sock");
    const calls: unknown[][] = [];
    cleanups.push(await fakeNeovim(socket, "/repo", calls));
    await openInNeovim(socket, "/repo/a.ts", 3, 7, "thread-1");
    await openInNeovim(socket, "/repo/a.ts", 0, 0, undefined);
    expect(calls).toEqual([
      ["/repo/a.ts", 3, 7, "thread-1"],
      ["/repo/a.ts", 0, 0, ""],
    ]);
  });
});
