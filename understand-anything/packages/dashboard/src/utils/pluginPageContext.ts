import type { AstrBotPluginPageBridge } from "./astrbotBridge";

type PluginPageLocation = Pick<Location, "pathname" | "search">;
type BridgeWindow = Window & {
  AstrBotPluginPage?: AstrBotPluginPageBridge;
  __uaBridgeLoadPromise?: Promise<AstrBotPluginPageBridge | undefined>;
};

const PLUGIN_PAGE_CONTENT_PREFIX = ["", "api", "plugin", "page", "content", ""].join("/");
const BRIDGE_SDK_PATH = ["", "api", "plugin", "page", "bridge-sdk.js"].join("/");

function currentLocation(): PluginPageLocation {
  if (typeof window === "undefined") {
    return { pathname: "", search: "" };
  }
  return window.location;
}

export function currentBridge(): AstrBotPluginPageBridge | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return (window as BridgeWindow).AstrBotPluginPage;
}

export function isAstrBotPluginPageContext(
  locationLike: PluginPageLocation = currentLocation(),
  bridge: unknown = currentBridge(),
): boolean {
  if (bridge) {
    return true;
  }
  if (locationLike.pathname.includes(PLUGIN_PAGE_CONTENT_PREFIX)) {
    return true;
  }
  return new URLSearchParams(locationLike.search).has("asset_token");
}

export function buildBridgeSdkUrl(
  locationLike: PluginPageLocation = currentLocation(),
): string {
  const params = new URLSearchParams();
  params.set("i18n_scope", "page");
  const assetToken = new URLSearchParams(locationLike.search).get("asset_token");
  if (assetToken) {
    params.set("asset_token", assetToken);
  }
  return `${BRIDGE_SDK_PATH}?${params.toString()}`;
}

export function ensureAstrBotPluginPageBridge(): Promise<
  AstrBotPluginPageBridge | undefined
> {
  if (typeof window === "undefined") {
    return Promise.resolve(undefined);
  }
  const bridgeWindow = window as BridgeWindow;
  if (bridgeWindow.AstrBotPluginPage) {
    return Promise.resolve(bridgeWindow.AstrBotPluginPage);
  }
  if (!isAstrBotPluginPageContext()) {
    return Promise.resolve(undefined);
  }
  if (bridgeWindow.__uaBridgeLoadPromise) {
    return bridgeWindow.__uaBridgeLoadPromise;
  }

  bridgeWindow.__uaBridgeLoadPromise = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = buildBridgeSdkUrl();
    script.async = false;
    script.onload = () => resolve(bridgeWindow.AstrBotPluginPage);
    script.onerror = () => resolve(undefined);
    document.head.appendChild(script);
  });
  return bridgeWindow.__uaBridgeLoadPromise;
}
