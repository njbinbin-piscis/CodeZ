import React from "react";
import ReactDOM from "react-dom/client";
import "./monaco-setup";
import "./i18n";
import { initAppearanceTheme, initUiFontScale } from "./theme";
import App from "./App";
import "./index.css";

initAppearanceTheme();
initUiFontScale();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
