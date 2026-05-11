import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";

import type { AstrBotPluginPageBridge } from "./utils/astrbotBridge";
import { LOCAL_MESSAGES, type LocaleCode, type LocaleMessages } from "./i18n/messages";

type FormatVars = Record<string, string | number | boolean | null | undefined>;

type I18nContextValue = {
  locale: LocaleCode;
  t: (key: string, fallback: string, vars?: FormatVars) => string;
};

type I18nProviderProps = {
  bridge?: AstrBotPluginPageBridge;
  children: ReactNode;
};

const DEFAULT_LOCALE: LocaleCode = "en-US";
const DASHBOARD_KEY_PREFIX = "pages.dashboard.ui.";

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  t: (key, fallback, vars) => formatMessage(fallback || key, vars)
});

export function normalizeLocale(locale?: string | null): LocaleCode {
  const value = (locale || "").toLowerCase();
  if (value.startsWith("zh")) {
    return "zh-CN";
  }
  if (value.startsWith("ru")) {
    return "ru-RU";
  }
  return DEFAULT_LOCALE;
}

export function dashboardI18nKey(key: string): string {
  if (
    key.startsWith("pages.") ||
    key.startsWith("config.") ||
    key.startsWith("metadata.")
  ) {
    return key;
  }
  return `${DASHBOARD_KEY_PREFIX}${key}`;
}

export function getMessageByPath(messages: LocaleMessages | undefined, path: string): string | undefined {
  if (!messages) {
    return undefined;
  }
  let cursor: unknown = messages;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object" || !(part in cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

function isMessageMap(value: unknown): value is Record<string, LocaleMessages> {
  return Boolean(value && typeof value === "object");
}

function bridgeMessages(bridge?: AstrBotPluginPageBridge): Record<string, LocaleMessages> {
  const messages = bridge?.getI18n?.();
  return isMessageMap(messages) ? messages : {};
}

export function formatMessage(template: string, vars?: FormatVars): string {
  if (!vars) {
    return template;
  }
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    const value = vars[key];
    return value === null || value === undefined ? match : String(value);
  });
}

export function translateLocal(
  locale: LocaleCode,
  key: string,
  fallback: string,
  vars?: FormatVars
): string {
  const fullKey = dashboardI18nKey(key);
  const translated =
    getMessageByPath(LOCAL_MESSAGES[locale], fullKey) ??
    getMessageByPath(LOCAL_MESSAGES[DEFAULT_LOCALE], fullKey) ??
    fallback;
  return formatMessage(translated, vars);
}

function translateFromMessages(
  messages: Record<string, LocaleMessages>,
  locale: LocaleCode,
  key: string,
  fallback?: string,
  vars?: FormatVars
): string | undefined {
  const fullKey = dashboardI18nKey(key);
  const translated =
    getMessageByPath(messages[locale], fullKey) ??
    getMessageByPath(messages[DEFAULT_LOCALE], fullKey);
  if (translated === undefined) {
    return fallback === undefined ? undefined : formatMessage(fallback, vars);
  }
  return formatMessage(translated, vars);
}

export function createDashboardTranslator(
  bridge?: AstrBotPluginPageBridge,
  initialLocale: LocaleCode = DEFAULT_LOCALE
) {
  const messages = bridgeMessages(bridge);
  return (key: string, fallback: string, vars?: FormatVars): string => {
    const fullKey = dashboardI18nKey(key);
    const locale = normalizeLocale(bridge?.getLocale?.() ?? initialLocale);
    const translated = translateFromMessages(messages, locale, fullKey, undefined, vars);
    if (translated !== undefined) {
      return translated;
    }
    if (Object.keys(messages).length === 0 && bridge?.t) {
      const missing = `__ua_i18n_missing__${fullKey}`;
      const bridgeValue = bridge.t(fullKey, missing);
      if (typeof bridgeValue === "string" && bridgeValue !== missing) {
        return formatMessage(bridgeValue, vars);
      }
    }
    return translateLocal(locale, fullKey, fallback, vars);
  };
}

export function I18nProvider({ bridge, children }: I18nProviderProps) {
  const [locale, setLocale] = useState<LocaleCode>(() => {
    if (bridge?.getLocale) {
      return normalizeLocale(bridge.getLocale());
    }
    if (typeof navigator !== "undefined") {
      return normalizeLocale(navigator.language);
    }
    return DEFAULT_LOCALE;
  });
  const [messages, setMessages] = useState<Record<string, LocaleMessages>>(() =>
    bridgeMessages(bridge)
  );

  useEffect(() => {
    let disposed = false;

    const applyContext = (
      nextLocale?: string | null,
      nextMessages?: Record<string, LocaleMessages>
    ) => {
      if (disposed) {
        return;
      }
      setLocale(normalizeLocale(nextLocale));
      if (nextMessages) {
        setMessages(nextMessages);
      }
    };

    const ready = bridge?.ready?.();
    if (ready && typeof ready.then === "function") {
      ready
        .then(() => applyContext(bridge?.getLocale?.(), bridgeMessages(bridge)))
        .catch(() => undefined);
    } else {
      applyContext(bridge?.getLocale?.(), bridgeMessages(bridge));
    }

    const unsubscribe = bridge?.onContext?.((context) => {
      const nextLocale =
        context && typeof context === "object" && "locale" in context
          ? String((context as { locale?: unknown }).locale ?? "")
          : bridge?.getLocale?.();
      const nextMessages =
        context && typeof context === "object" && isMessageMap(context.i18n)
          ? context.i18n
          : bridgeMessages(bridge);
      applyContext(nextLocale, nextMessages);
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [bridge]);

  const t = useCallback(
    (key: string, fallback: string, vars?: FormatVars) => {
      const fullKey = dashboardI18nKey(key);
      const translated = translateFromMessages(
        messages,
        locale,
        fullKey,
        undefined,
        vars
      );
      if (translated !== undefined) {
        return translated;
      }
      return translateLocal(locale, fullKey, fallback, vars);
    },
    [locale, messages]
  );

  const value = useMemo<I18nContextValue>(() => ({ locale, t }), [locale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function formatDisplayKey(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function pluralKey(singularKey: string, pluralKeyValue: string, count: number): string {
  return count === 1 ? singularKey : pluralKeyValue;
}
