import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  chunkTerminalWrite,
  DEFAULT_TERMINAL_ID,
  TERMINAL_WRITE_MAX_LENGTH,
  TerminalAttachInput,
  TerminalError,
  TerminalOpenInput,
  TerminalProviderEnvironmentError,
} from "./terminal.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const encodeTerminalError = Schema.encodeUnknownSync(TerminalError);
const decodeTerminalError = Schema.decodeUnknownSync(TerminalError);

function decodeSync<S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;
}

describe("TerminalProviderEnvironmentError", () => {
  it("round-trips its required cause without exposing it in the message", () => {
    const cause = { operation: "read-secret", detail: "secret backend unavailable" };
    const error = new TerminalProviderEnvironmentError({
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      cause,
    });
    const encoded = encodeTerminalError(error);
    const decoded = decodeTerminalError(encoded);

    expect(decoded).toMatchObject({
      _tag: "TerminalProviderEnvironmentError",
      providerInstanceId: "codex_work",
      cause,
    });
    expect(decoded.message).toBe(
      "Could not prepare the terminal environment for provider instance: codex_work",
    );
    expect(decoded.message).not.toContain("secret backend unavailable");
  });
});

describe("TerminalOpenInput", () => {
  it("drops invalid env keys while retaining valid overrides", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
      env: { "bad-key": "1", GOOD_KEY: "2" },
    });
    expect(parsed.env).toEqual({ GOOD_KEY: "2" });
  });

  it("accepts a launch command and rejects an empty program", () => {
    const base = { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, cwd: "/tmp/project" };
    const parsed = decodeSync(TerminalOpenInput, {
      ...base,
      command: { file: "fish", args: ["-l", "-c", "exec nvim"] },
    });
    expect(parsed.command).toEqual({ file: "fish", args: ["-l", "-c", "exec nvim"] });
    expect(() =>
      decodeSync(TerminalOpenInput, { ...base, command: { file: " ", args: [] } }),
    ).toThrow();
  });
});

describe("TerminalAttachInput", () => {
  it("carries an optional launch command", () => {
    const parsed = decodeSync(TerminalAttachInput, {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      command: { file: "nvim", args: [] },
    });
    expect(parsed.command).toEqual({ file: "nvim", args: [] });
  });
});

describe("chunkTerminalWrite", () => {
  it("splits oversized writes so every chunk fits the contract", () => {
    const chunks = chunkTerminalWrite("y".repeat(TERMINAL_WRITE_MAX_LENGTH * 2 + 5));
    expect(chunks.map((chunk) => chunk.length)).toEqual([
      TERMINAL_WRITE_MAX_LENGTH,
      TERMINAL_WRITE_MAX_LENGTH,
      5,
    ]);
    expect(chunks.join("")).toHaveLength(TERMINAL_WRITE_MAX_LENGTH * 2 + 5);
  });

  it("does not cut a surrogate pair in half at the boundary", () => {
    const data = `${"z".repeat(TERMINAL_WRITE_MAX_LENGTH - 1)}😀tail`;
    const chunks = chunkTerminalWrite(data);
    expect(chunks[0]).toHaveLength(TERMINAL_WRITE_MAX_LENGTH - 1);
    expect(chunks[1]).toBe("😀tail");
    expect(chunks.join("")).toBe(data);
  });
});
