import { StrictMode } from "react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { I18nProvider } from "./i18n";
import type { AstrBotWindow } from "./utils/astrbotBridge";
import {
  currentBridge,
  ensureAstrBotPluginPageBridge,
  isAstrBotPluginPageContext,
} from "./utils/pluginPageContext";

function Root() {
  const [bridge, setBridge] = useState(() => currentBridge());

  useEffect(() => {
    if (!isAstrBotPluginPageContext()) {
      return;
    }
    let disposed = false;
    ensureAstrBotPluginPageBridge().then((loadedBridge) => {
      if (!disposed) {
        setBridge(loadedBridge ?? (window as AstrBotWindow).AstrBotPluginPage);
      }
    });
    return () => {
      disposed = true;
    };
  }, []);

  return (
    <I18nProvider bridge={bridge}>
      <App />
    </I18nProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
