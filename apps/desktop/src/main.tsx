import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./App.css";
import "./workbench.css";
import { invoke } from "@tauri-apps/api/core";

// Temporary diagnostics for release builds, where the webview console is not
// reachable. Every startup milestone and every error goes to a file.
const log = (message: string) => {
  void invoke("debug_log", { message }).catch(() => {
    // Diagnostics must never break the app.
  });
};

log("main.tsx: module start");

window.addEventListener("error", (event) => {
  log(`window error: ${event.message} @ ${event.filename}:${event.lineno}`);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  log(`unhandled rejection: ${reason}`);
});

const root = document.getElementById("root");
log(`main.tsx: root element ${root ? "found" : "MISSING"}`);

try {
  ReactDOM.createRoot(root as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  log("main.tsx: render() called");
} catch (error) {
  log(`main.tsx: render threw ${String(error)}`);
  throw error;
}
