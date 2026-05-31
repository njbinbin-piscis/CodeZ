import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// CodeZ M0 ships without translation bundles yet. The ported IDE components
// call `t("some.key") || "English fallback"`, so we configure i18next to
// return an empty string for any missing key — that makes every `|| fallback`
// render its inline English default. Real locale resources can be layered in
// later without touching the components.
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: {},
  interpolation: { escapeValue: false },
  parseMissingKeyHandler: () => "",
});

export default i18n;
