import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { subscribeLocalStorageKey } from "../../hooks/useLocalStorage";
import { readUsagePagePreferences, saveUsagePagePreferences } from "./usagePagePreferences";

const key = "t3code:usage-page-preferences:v1";
let values: Map<string, string>;
let storage: Pick<Storage, "getItem" | "setItem">;

beforeEach(() => {
  values = new Map();
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: storage }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Usage page preferences", () => {
  it("round-trips filters, notifies other views, and reads older saves", () => {
    const preferences = {
      metric: "cost",
      windowDays: 7,
      hiddenProviders: ["codex"],
      skipWeekendsForPace: true,
    } as const;
    const onChange = vi.fn(() => readUsagePagePreferences());
    const unsubscribe = subscribeLocalStorageKey(key, onChange);
    try {
      saveUsagePagePreferences(preferences);
      expect(onChange).toHaveReturnedWith(preferences);
    } finally {
      unsubscribe();
    }

    values.set(key, '{"metric":"tokens","windowDays":30}');
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", windowDays: 30 });
  });

  // regression: #10189 an invalid saved usage selection was never replaced
  it.each([
    "not-json",
    '{"metric":"unknown","windowDays":7}',
    '{"metric":"cost","windowDays":365}',
  ])("replaces invalid preferences on the next save: %s", (value) => {
    values.set(key, value);
    expect(readUsagePagePreferences()).toEqual({ metric: "limits", windowDays: 30 });
    saveUsagePagePreferences({ metric: "tokens", windowDays: 7 });
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", windowDays: 7 });
  });
});
