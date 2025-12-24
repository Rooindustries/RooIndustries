import React from "react";
import ReactDOM from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import "@fontsource-variable/roboto-flex/opsz.css";
import App from "./App";
import "./index.css";

const container = document.getElementById("root");

if (typeof window !== "undefined") {
  // react-snap serializes this into the HTML so the client can hydrate without refetching.
  window.__SNAP_STATE__ = window.__SNAP_STATE__ || {};
  window.snapSaveState = () => ({
    __PRELOADED_STATE__: window.__SNAP_STATE__ || {},
  });
}

const app = (
  <React.StrictMode>
    <HelmetProvider>
      <App />
    </HelmetProvider>
  </React.StrictMode>
);

if (container?.hasChildNodes()) {
  // Hydrate if prerendered HTML exists.
  ReactDOM.hydrateRoot(container, app);
} else if (container) {
  ReactDOM.createRoot(container).render(app);
}

if (typeof window !== "undefined" && window.__PRELOADED_STATE__) {
  // Cleanup after hydration to reduce memory usage.
  setTimeout(() => {
    delete window.__PRELOADED_STATE__;
  }, 0);
}
