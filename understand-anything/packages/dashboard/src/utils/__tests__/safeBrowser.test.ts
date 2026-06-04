import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getStorageItem,
  removeStorageItem,
  safeReplaceState,
  setStorageItem,
} from "../safeBrowser";

describe("sandbox-safe browser helpers", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));

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

  it("does not throw when storage methods are blocked by iframe sandboxing", () => {
    const blockedStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };

    vi.stubGlobal("window", {
      localStorage: blockedStorage,
      sessionStorage: blockedStorage,
    });

    expect(getStorageItem("local", "key")).toBeNull();
    expect(getStorageItem("session", "key")).toBeNull();
    expect(() => setStorageItem("local", "key", "value")).not.toThrow();
    expect(() => setStorageItem("session", "key", "value")).not.toThrow();
    expect(() => removeStorageItem("local", "key")).not.toThrow();
    expect(() => removeStorageItem("session", "key")).not.toThrow();
  });

  it("keeps theme persistence behind sandbox-safe storage helpers", () => {
    const themeContext = readFileSync(
      resolve(testDir, "../../themes/ThemeContext.tsx"),
      "utf8",
    );

    expect(themeContext).toContain("../utils/safeBrowser");
    expect(themeContext).not.toMatch(/\b(?:window\.)?(?:localStorage|sessionStorage)\s*\./);
  });

  it("does not throw when history.replaceState is blocked by iframe sandboxing", () => {
    vi.stubGlobal("window", {
      location: { pathname: "/dashboard", search: "" },
      history: {
        replaceState: () => {
          throw new Error("blocked");
        },
      },
    });

    expect(() => safeReplaceState("/dashboard")).not.toThrow();
  });

  it("does not call history.replaceState in AstrBot plugin page iframe contexts", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        pathname: "/api/plugin/page/content/astrbot_plugin_UnderstandAnything/dashboard/",
        search: "?asset_token=token",
      },
      history: { replaceState },
    });

    safeReplaceState("/api/plugin/page/content/astrbot_plugin_UnderstandAnything/dashboard/");

    expect(replaceState).not.toHaveBeenCalled();
  });
});
