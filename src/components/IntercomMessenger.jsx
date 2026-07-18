import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

const INTERCOM_APP_ID =
  process.env.NEXT_PUBLIC_INTERCOM_APP_ID ||
  process.env.REACT_APP_INTERCOM_APP_ID ||
  "xvd1alq5";
const INTERCOM_SCRIPT_ID = "intercom-embed-script";
const INTERCOM_SRC = `https://widget.intercom.io/widget/${INTERCOM_APP_ID}`;

const normalizePath = (path) => {
  if (typeof path !== "string") return "";
  if (path === "/") return "/";
  return path.replace(/\/+$/, "");
};

const isRouteDisabled = (pathname, disabledRoutes) => {
  if (!Array.isArray(disabledRoutes) || disabledRoutes.length === 0) {
    return false;
  }

  const normalizedPath = normalizePath(pathname);

  return disabledRoutes.some((route) => {
    if (route instanceof RegExp) {
      return route.test(normalizedPath);
    }

    const normalizedRoute = normalizePath(route);
    if (!normalizedRoute) return false;

    if (normalizedRoute === "/") {
      return normalizedPath === "/";
    }

    return (
      normalizedPath === normalizedRoute ||
      normalizedPath.startsWith(`${normalizedRoute}/`)
    );
  });
};

const createIntercomSettings = ({ hideLauncher = false } = {}) => ({
  app_id: INTERCOM_APP_ID,
  alignment: "right",
  horizontal_padding: 24,
  vertical_padding: 24,
  hide_default_launcher: hideLauncher,
});

const queueIntercom = () => {
  const queuedIntercom = function queuedIntercom() {
    queuedIntercom.c(arguments);
  };
  queuedIntercom.q = [];
  queuedIntercom.c = (args) => {
    queuedIntercom.q.push(args);
  };
  window.Intercom = queuedIntercom;
};

const bootOrUpdateIntercom = (settings) => {
  if (typeof window.Intercom !== "function") {
    return;
  }

  if (window.__rooIntercomBooted) {
    window.Intercom("update", settings);
    return;
  }

  window.Intercom("boot", settings);
  window.__rooIntercomBooted = true;
};

const loadIntercom = (settings) => {
  window.intercomSettings = settings;

  if (typeof window.Intercom !== "function") {
    queueIntercom();
  }

  bootOrUpdateIntercom(settings);

  if (document.getElementById(INTERCOM_SCRIPT_ID)) {
    return;
  }

  const script = document.createElement("script");
  script.id = INTERCOM_SCRIPT_ID;
  script.type = "text/javascript";
  script.async = true;
  script.src = INTERCOM_SRC;

  const firstScript = document.getElementsByTagName("script")[0];
  if (firstScript?.parentNode) {
    firstScript.parentNode.insertBefore(script, firstScript);
  } else {
    document.body.appendChild(script);
  }
};

function IntercomMessenger({ disabledRoutes = [], disabled = false }) {
  const location = useLocation();
  const isDisabledRef = useRef(false);
  const pathname = location.pathname || "/";
  const isDisabled =
    Boolean(disabled) || isRouteDisabled(pathname, disabledRoutes);

  isDisabledRef.current = isDisabled;

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    if (isDisabledRef.current) {
      return;
    }

    loadIntercom(createIntercomSettings());

    return () => {
      if (typeof window.Intercom === "function") {
        window.Intercom("update", createIntercomSettings({ hideLauncher: true }));
        window.Intercom("hide");
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const settings = createIntercomSettings({ hideLauncher: isDisabled });
    window.intercomSettings = settings;

    if (isDisabled && typeof window.Intercom === "function") {
      window.Intercom("update", settings);
      window.Intercom("hide");
      return;
    }

    if (!isDisabled) {
      loadIntercom(settings);
    }
  }, [isDisabled, pathname]);

  return null;
}

export default IntercomMessenger;
