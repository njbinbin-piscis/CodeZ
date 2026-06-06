import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./i18n/en";
import zh from "./i18n/zh";

export const LANGUAGE_STORAGE_KEY = "agentz-language";

function detectInitialLanguage(): "zh" | "en" {
  const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (saved === "zh" || saved === "en") return saved;
  const nav = navigator.language.toLowerCase();
  return nav.startsWith("zh") ? "zh" : "en";
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: detectInitialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

/** Switch UI language and persist locally. */
export function setLanguage(lang: "zh" | "en") {
  void i18n.changeLanguage(lang);
  localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
}

export default i18n;
