import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getStorageItem,
  removeStorageItem,
  safeReplaceState,
  setStorageItem,
} from "../safeBrowser";

describe("sandbox-safe browser helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not throw when storage properties are blocked by iframe sandboxing", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("blocked");
      },
      get sessionStorage() {
        throw new Error("blocked");
      },
    });

    expect(getStorageItem("local", "key")).toBeNull();
    expect(getStorageItem("session", "key")).toBeNull();
    expect(() => setStorageItem("local", "key", "value")).not.toThrow();
    expect(() => setStorageItem("session", "key", "value")).not.toThrow();
    expect(() => removeStorageItem("local", "key")).not.toThrow();
  });

  it("does not throw when history.replaceState is blocked by iframe sandboxing", () => {
    vi.stubGlobal("window", {
      history: {
        replaceState: () => {
          throw new Error("blocked");
        },
      },
    });

    expect(() => safeReplaceState("/dashboard")).not.toThrow();
  });
});
