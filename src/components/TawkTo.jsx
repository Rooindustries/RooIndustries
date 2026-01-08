import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

const TAWK_SCRIPT_ID = "tawkto-embed-script";
const TAWK_SRC = "https://embed.tawk.to/695f6a4eaab7e8197fb21bcd/1jeebegq4";

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

function TawkTo({ disabledRoutes = [] }) {
  const location = useLocation();
  const isDisabledRef = useRef(false);
  const pathname = location.pathname || "/";
  const isDisabled = isRouteDisabled(pathname, disabledRoutes);

  isDisabledRef.current = isDisabled;

  useEffect(() => {
    if (typeof window === "undefined") return;

    window.Tawk_API = window.Tawk_API || {};
    const api = window.Tawk_API;
    const existingOnLoad = api.onLoad;

    api.onLoad = () => {
      if (typeof existingOnLoad === "function") {
        existingOnLoad();
      }
      if (isDisabledRef.current && typeof api.hideWidget === "function") {
        api.hideWidget();
        return;
      }
      if (!isDisabledRef.current && typeof api.showWidget === "function") {
        api.showWidget();
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined")
      return;
    if (isDisabled) return;
    if (document.getElementById(TAWK_SCRIPT_ID)) return;

    window.Tawk_API = window.Tawk_API || {};
    window.Tawk_LoadStart = new Date();

    const script = document.createElement("script");
    script.id = TAWK_SCRIPT_ID;
    script.async = true;
    script.src = TAWK_SRC;
    script.charset = "UTF-8";
    script.setAttribute("crossorigin", "*");

    const firstScript = document.getElementsByTagName("script")[0];
    if (firstScript?.parentNode) {
      firstScript.parentNode.insertBefore(script, firstScript);
    } else {
      document.body.appendChild(script);
    }
  }, [isDisabled]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const api = window.Tawk_API;
    if (!api) return;

    if (isDisabled && typeof api.hideWidget === "function") {
      api.hideWidget();
      return;
    }
    if (!isDisabled && typeof api.showWidget === "function") {
      api.showWidget();
    }
  }, [isDisabled]);

  return null;
}

export default TawkTo;
