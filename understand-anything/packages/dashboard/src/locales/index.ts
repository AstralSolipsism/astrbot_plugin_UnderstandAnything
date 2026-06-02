import zh from "./zh";

export type LocaleKey = "en" | "zh" | "zh-TW" | "ja" | "ko";
export type Locale = typeof zh;

export const locales: Record<LocaleKey, Locale> = {
  en: zh,
  zh,
  "zh-TW": zh,
  ja: zh,
  ko: zh,
};

export function getLocale(key: LocaleKey): Locale {
  void key;
  return zh;
}

export function resolveLocaleKey(lang: string | undefined): LocaleKey {
  void lang;
  return "zh";
}

export { zh };
