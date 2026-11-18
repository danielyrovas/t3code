// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off -- a socket client; Neovim is outside the Effect runtime.
/**
 * Fork-only: terminals get `T3_*` variables, and launch-command terminals a short, predictable
 * Neovim `--listen` socket (`T3_NVIM_SOCKET`). The server opens files there over msgpack-RPC.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ExternalLauncherEditorSpawnError, type LaunchEditorInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

/** macOS limits a unix socket path to 104 bytes, so the directory stays short and fixed. */
export function defaultNeovimSocketDir(platform: NodeJS.Platform): string | null {
  if (platform === "win32") return null;
  const uid = NodeOS.userInfo().uid;
  return `/tmp/t3-nvim-${uid}`;
}

const shortHash = (value: string, length: number) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, length);

/** All sockets of one T3 home share this prefix, so a lookup never reaches another T3. */
const homePrefix = (baseDir: string) => `${shortHash(baseDir, 8)}-`;

export function neovimSocketPath(input: {
  readonly socketDir: string;
  readonly baseDir: string;
  readonly threadId: string;
  readonly terminalId: string;
}): string {
  return NodePath.join(
    input.socketDir,
    `${homePrefix(input.baseDir)}${shortHash(`${input.threadId}\u0000${input.terminalId}`, 12)}.sock`,
  );
}

export interface TerminalIntegrationOptions {
  readonly baseDir: string;
  /** From {@link defaultNeovimSocketDir}; null turns the socket off. */
  readonly socketDir: string | null;
}

/**
 * The `T3_*` variables for a terminal; it never rejects. For a launch-command terminal it also prepares the
 * socket directory and removes a stale socket, so `nvim --listen` works after a crash or a
 * restart of the same terminal.
 */
export async function terminalIntegrationEnv(
  options: TerminalIntegrationOptions,
  session: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly projectRoot: string;
    readonly launchesProgram: boolean;
  },
): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    T3_THREAD_ID: session.threadId,
    T3_TERMINAL_ID: session.terminalId,
    T3_PROJECT_ROOT: session.projectRoot,
    T3_HOME: options.baseDir,
  };
  const socketDir = options.socketDir;
  if (session.launchesProgram && socketDir) {
    const socket = neovimSocketPath({
      socketDir,
      baseDir: options.baseDir,
      threadId: session.threadId,
      terminalId: session.terminalId,
    });
    try {
      await NodeFSP.mkdir(socketDir, { recursive: true, mode: 0o700 });
      await NodeFSP.chmod(socketDir, 0o700);
      await NodeFSP.rm(socket, { force: true });
      env.T3_NVIM_SOCKET = socket;
    } catch {
      // Without a socket, Neovim still starts; only "open in Neovim" is unavailable.
    }
  }
  return env;
}

function encodeMsgpack(value: unknown, out: Buffer[]): void {
  if (value === null || value === undefined) {
    out.push(Buffer.from([0xc0]));
  } else if (typeof value === "boolean") {
    out.push(Buffer.from([value ? 0xc3 : 0xc2]));
  } else if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      const buffer = Buffer.alloc(9);
      buffer[0] = 0xcb;
      buffer.writeDoubleBE(value, 1);
      out.push(buffer);
    } else if (value >= 0 && value < 0x80) {
      out.push(Buffer.from([value]));
    } else if (value < 0 && value >= -32) {
      out.push(Buffer.from([value & 0xff]));
    } else {
      const buffer = Buffer.alloc(9);
      buffer[0] = 0xd3;
      buffer.writeBigInt64BE(BigInt(value), 1);
      out.push(buffer);
    }
  } else if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    let header: Buffer;
    if (bytes.length < 32) header = Buffer.from([0xa0 | bytes.length]);
    else if (bytes.length < 0x100) header = Buffer.from([0xd9, bytes.length]);
    else if (bytes.length < 0x10000) {
      header = Buffer.alloc(3);
      header[0] = 0xda;
      header.writeUInt16BE(bytes.length, 1);
    } else {
      header = Buffer.alloc(5);
      header[0] = 0xdb;
      header.writeUInt32BE(bytes.length, 1);
    }
    out.push(header, bytes);
  } else if (Array.isArray(value)) {
    out.push(lengthHeader(value.length, 0x90, 0xdc));
    for (const item of value) encodeMsgpack(item, out);
  } else if (typeof value === "object") {
    const entries = Object.entries(value);
    out.push(lengthHeader(entries.length, 0x80, 0xde));
    for (const [key, item] of entries) {
      encodeMsgpack(key, out);
      encodeMsgpack(item, out);
    }
  } else {
    throw new TypeError(`Cannot encode ${typeof value} as msgpack`);
  }
}

function lengthHeader(length: number, fix: number, wide16: number): Buffer {
  if (length < 16) return Buffer.from([fix | length]);
  if (length < 0x10000) {
    const buffer = Buffer.alloc(3);
    buffer[0] = wide16;
    buffer.writeUInt16BE(length, 1);
    return buffer;
  }
  const buffer = Buffer.alloc(5);
  buffer[0] = wide16 + 1;
  buffer.writeUInt32BE(length, 1);
  return buffer;
}

export function encodeMsgpackValue(value: unknown): Buffer {
  const out: Buffer[] = [];
  encodeMsgpack(value, out);
  return Buffer.concat(out);
}

class IncompleteMsgpack extends Error {}

/** Decodes one value at `offset`; throws IncompleteMsgpack when the buffer ends too soon. */
export function decodeMsgpackValue(
  buffer: Buffer,
  offset = 0,
): { readonly value: unknown; readonly offset: number } {
  const need = (bytes: number) => {
    if (offset + bytes > buffer.length) throw new IncompleteMsgpack();
  };
  need(1);
  const type = buffer[offset++]!;
  const raw = (length: number) => {
    need(length);
    const slice = buffer.subarray(offset, offset + length);
    offset += length;
    return slice;
  };
  const uint = (bytes: 1 | 2 | 4 | 8) => {
    need(bytes);
    const value =
      bytes === 1
        ? buffer.readUInt8(offset)
        : bytes === 2
          ? buffer.readUInt16BE(offset)
          : bytes === 4
            ? buffer.readUInt32BE(offset)
            : Number(buffer.readBigUInt64BE(offset));
    offset += bytes;
    return value;
  };
  const int = (bytes: 1 | 2 | 4 | 8) => {
    need(bytes);
    const value =
      bytes === 1
        ? buffer.readInt8(offset)
        : bytes === 2
          ? buffer.readInt16BE(offset)
          : bytes === 4
            ? buffer.readInt32BE(offset)
            : Number(buffer.readBigInt64BE(offset));
    offset += bytes;
    return value;
  };
  const array = (length: number) => {
    const items: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const decoded = decodeMsgpackValue(buffer, offset);
      items.push(decoded.value);
      offset = decoded.offset;
    }
    return items;
  };
  const map = (length: number) => {
    const result: Record<string, unknown> = {};
    for (let index = 0; index < length; index++) {
      const key = decodeMsgpackValue(buffer, offset);
      const item = decodeMsgpackValue(buffer, key.offset);
      result[String(key.value)] = item.value;
      offset = item.offset;
    }
    return result;
  };
  const ext = (length: number) => {
    const extType = int(1);
    return { extType, data: raw(length) };
  };
  const done = (value: unknown) => ({ value, offset });

  if (type < 0x80) return done(type);
  if (type < 0x90) return done(map(type & 0x0f));
  if (type < 0xa0) return done(array(type & 0x0f));
  if (type < 0xc0) return done(raw(type & 0x1f).toString("utf8"));
  if (type >= 0xe0) return done(type - 0x100);
  switch (type) {
    case 0xc0:
      return done(null);
    case 0xc2:
      return done(false);
    case 0xc3:
      return done(true);
    case 0xc4:
      return done(raw(uint(1)));
    case 0xc5:
      return done(raw(uint(2)));
    case 0xc6:
      return done(raw(uint(4)));
    case 0xc7:
      return done(ext(uint(1)));
    case 0xc8:
      return done(ext(uint(2)));
    case 0xc9:
      return done(ext(uint(4)));
    case 0xca: {
      need(4);
      const value = buffer.readFloatBE(offset);
      offset += 4;
      return done(value);
    }
    case 0xcb: {
      need(8);
      const value = buffer.readDoubleBE(offset);
      offset += 8;
      return done(value);
    }
    case 0xcc:
      return done(uint(1));
    case 0xcd:
      return done(uint(2));
    case 0xce:
      return done(uint(4));
    case 0xcf:
      return done(uint(8));
    case 0xd0:
      return done(int(1));
    case 0xd1:
      return done(int(2));
    case 0xd2:
      return done(int(4));
    case 0xd3:
      return done(int(8));
    case 0xd4:
      return done(ext(1));
    case 0xd5:
      return done(ext(2));
    case 0xd6:
      return done(ext(4));
    case 0xd7:
      return done(ext(8));
    case 0xd8:
      return done(ext(16));
    case 0xd9:
      return done(raw(uint(1)).toString("utf8"));
    case 0xda:
      return done(raw(uint(2)).toString("utf8"));
    case 0xdb:
      return done(raw(uint(4)).toString("utf8"));
    case 0xdc:
      return done(array(uint(2)));
    case 0xdd:
      return done(array(uint(4)));
    case 0xde:
      return done(map(uint(2)));
    case 0xdf:
      return done(map(uint(4)));
    default:
      throw new Error(`Unknown msgpack type 0x${type.toString(16)}`);
  }
}

export class NeovimRpcError extends Error {}

/** Sends one request to the Neovim at `socket` and resolves with its result. */
export function neovimRequest(
  socket: string,
  method: string,
  params: ReadonlyArray<unknown>,
  timeoutMs = 5_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const connection = NodeNet.createConnection(socket);
    let pending = Buffer.alloc(0);
    const finish = (error: Error | null, value?: unknown) => {
      clearTimeout(timer);
      connection.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new NeovimRpcError(`Neovim did not answer ${method} in ${timeoutMs} ms`)),
      timeoutMs,
    );
    connection.on("error", (error) => finish(error));
    connection.on("connect", () => {
      connection.write(encodeMsgpackValue([0, 1, method, params]));
    });
    connection.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length > 0) {
        let decoded: { value: unknown; offset: number };
        try {
          decoded = decodeMsgpackValue(pending);
        } catch (error) {
          if (error instanceof IncompleteMsgpack) return;
          finish(error as Error);
          return;
        }
        pending = pending.subarray(decoded.offset);
        const message = decoded.value;
        // Only the response [1, msgid, error, result] matters; skip notifications.
        if (!Array.isArray(message) || message[0] !== 1 || message[1] !== 1) continue;
        const [, , error, result] = message as [number, number, unknown, unknown];
        if (error !== null && error !== undefined) {
          const text = Array.isArray(error) ? String(error[1]) : String(error);
          finish(new NeovimRpcError(text));
        } else {
          finish(null, result);
        }
        return;
      }
    });
    connection.on("close", () => finish(new NeovimRpcError("Neovim closed the connection")));
  });
}

const OPEN_LUA = `
local path, line, col = ...
local ok, t3 = pcall(require, "t3")
if ok and type(t3) == "table" and type(t3.open) == "function" then
  t3.open(path, line > 0 and line or nil, col > 0 and col or nil)
  return true
end
vim.cmd.edit(vim.fn.fnameescape(path))
if line > 0 then
  pcall(vim.api.nvim_win_set_cursor, 0, { line, math.max(col - 1, 0) })
  vim.cmd("normal! zvzz")
end
return true
`;

const isRetryableConnectError = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  ((error as NodeJS.ErrnoException).code === "ENOENT" ||
    (error as NodeJS.ErrnoException).code === "ECONNREFUSED");

/**
 * Opens `path` at `line`/`column` in the Neovim at `socket`. A Neovim that is still starting
 * has no socket yet, so this retries until `waitMs` passes.
 */
export async function openInNeovim(input: {
  readonly socket: string;
  readonly path: string;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly waitMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.waitMs ?? 15_000);
  for (;;) {
    try {
      await neovimRequest(input.socket, "nvim_exec_lua", [
        OPEN_LUA,
        [input.path, input.line ?? 0, input.column ?? 0],
      ]);
      return;
    } catch (error) {
      if (!isRetryableConnectError(error) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * Finds a running Neovim of this T3 home whose working directory contains `targetPath`
 * (the deepest one wins). Used when the client does not name a terminal.
 */
export async function findNeovimSocketForPath(input: {
  readonly socketDir: string;
  readonly baseDir: string;
  readonly targetPath: string;
}): Promise<string | null> {
  let names: string[];
  try {
    names = await NodeFSP.readdir(input.socketDir);
  } catch {
    return null;
  }
  const prefix = homePrefix(input.baseDir);
  const target = NodePath.resolve(input.targetPath);
  let best: { socket: string; cwd: string } | null = null;
  let fallback: string | null = null;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".sock")) continue;
    const socket = NodePath.join(input.socketDir, name);
    let cwd: unknown;
    try {
      cwd = await neovimRequest(
        socket,
        "nvim_exec_lua",
        ["return vim.fn.getcwd(-1, -1)", []],
        1_000,
      );
    } catch {
      continue;
    }
    fallback ??= socket;
    if (typeof cwd !== "string") continue;
    const root = NodePath.resolve(cwd);
    const inside =
      target === root ||
      target.startsWith(root.endsWith(NodePath.sep) ? root : root + NodePath.sep);
    if (inside && (best === null || root.length > best.cwd.length)) best = { socket, cwd: root };
  }
  return best?.socket ?? fallback;
}

async function resolveOpenTarget(
  input: LaunchEditorInput,
): Promise<{ path: string; line?: number; column?: number }> {
  const raw = input.cwd.startsWith("~/")
    ? NodePath.join(NodeOS.homedir(), input.cwd.slice(2))
    : input.cwd;
  if (input.position) {
    return {
      path: raw,
      ...(input.position.line !== undefined ? { line: input.position.line } : {}),
      ...(input.position.column !== undefined ? { column: input.position.column } : {}),
    };
  }
  // Without a position the path may end in a `:line[:column]` suffix.
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(raw);
  if (!match) return { path: raw };
  const exists = await NodeFSP.stat(raw).then(
    () => true,
    () => false,
  );
  if (exists) return { path: raw };
  return {
    path: match[1]!,
    line: Number(match[2]),
    ...(match[3] ? { column: Number(match[3]) } : {}),
  };
}

/** Opens the target in the Neovim of `input.terminal`, or in the best running one. */
export const launchNeovimEditor = Effect.fn("neovim.launchEditor")(function* (
  input: LaunchEditorInput,
  options: { readonly baseDir: string },
) {
  const socketDir = defaultNeovimSocketDir(yield* HostProcess.Platform);
  return yield* Effect.tryPromise({
    try: async () => {
      if (!socketDir) throw new NeovimRpcError("Neovim integration is not supported on Windows");
      const target = await resolveOpenTarget(input);
      const socket = input.terminal
        ? neovimSocketPath({ socketDir, baseDir: options.baseDir, ...input.terminal })
        : await findNeovimSocketForPath({
            socketDir,
            baseDir: options.baseDir,
            targetPath: target.path,
          });
      if (!socket) throw new NeovimRpcError("No Neovim surface is running");
      await openInNeovim({
        socket,
        path: NodePath.resolve(target.path),
        line: target.line,
        column: target.column,
        ...(input.terminal ? {} : { waitMs: 0 }),
      });
    },
    catch: (cause) =>
      new ExternalLauncherEditorSpawnError({
        command: "nvim",
        args: ["--remote"],
        editor: "neovim",
        target: input.cwd,
        cause,
      }),
  });
});
