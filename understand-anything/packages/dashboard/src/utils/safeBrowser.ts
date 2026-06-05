type StorageKind = "local" | "session";

const ASTRBOT_PLUGIN_PAGE_CONTENT_PATH = ["", "api", "plugin", "page", "content", ""].join("/");

function storage(kind: StorageKind): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function getStorageItem(kind: StorageKind, key: string): string | null {
  try {
    return storage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function setStorageItem(kind: StorageKind, key: string, value: string): void {
  try {
    storage(kind)?.setItem(key, value);
  } catch {
    // Storage is unavailable in sandboxed plugin iframes without allow-same-origin.
  }
}

export function removeStorageItem(kind: StorageKind, key: string): void {
  try {
    storage(kind)?.removeItem(key);
  } catch {
    // Storage is unavailable in sandboxed plugin iframes without allow-same-origin.
  }
}

export function safeReplaceState(url: string): void {
  try {
    const search = window.location?.search ?? "";
    const pathname = window.location?.pathname ?? "";
    if (
      pathname.includes(ASTRBOT_PLUGIN_PAGE_CONTENT_PATH) ||
      new URLSearchParams(search).has("asset_token")
    ) {
      return;
    }
    window.history.replaceState(null, "", url);
  } catch {
    // Sandboxed plugin iframes may reject same-document URL mutations.
  }
}
