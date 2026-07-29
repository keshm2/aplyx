import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyUiPrefs } from "./lib/uiPrefs";
import "./styles/base.css";

// Apply the saved theme/font before first paint so the app never flashes
// the wrong appearance.
applyUiPrefs();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
