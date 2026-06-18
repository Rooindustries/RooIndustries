"use client";

import { useEffect, useState } from "react";
import { Moon, Tv } from "lucide-react";

const THEME_STORAGE_KEY = "roo-theme";
const THEME_LABELS = {
  default: "Roo Blue",
  dark: "Blackout",
};

const normalizeTheme = (value) => (value === "dark" ? "dark" : "default");

const updateThemeMeta = (theme) => {
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (!themeMeta) return;
  themeMeta.setAttribute("content", theme === "dark" ? "#070707" : "#000040");
};

const readTheme = () => {
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return normalizeTheme(document.documentElement.dataset.theme);
  }
};

const applyTheme = (theme, { persist = true } = {}) => {
  const normalized = normalizeTheme(theme);
  document.documentElement.dataset.theme = normalized;
  updateThemeMeta(normalized);

  if (persist) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, normalized);
    } catch {}

    window.dispatchEvent(
      new CustomEvent("roo:theme-change", {
        detail: { theme: normalized },
      })
    );
  }

  return normalized;
};

export default function TourneyThemeToggle() {
  const [theme, setTheme] = useState("default");

  useEffect(() => {
    setTheme(applyTheme(readTheme(), { persist: false }));

    const handleThemeChange = (event) => {
      const next = event?.detail?.theme;
      setTheme(
        next
          ? normalizeTheme(next)
          : applyTheme(readTheme(), { persist: false })
      );
    };

    const handleStorage = (event) => {
      if (event.key === THEME_STORAGE_KEY) {
        setTheme(applyTheme(readTheme(), { persist: false }));
      }
    };

    window.addEventListener("roo:theme-change", handleThemeChange);
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("roo:theme-change", handleThemeChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const nextTheme = theme === "dark" ? "default" : "dark";
  const themeLabel = THEME_LABELS[theme] || THEME_LABELS.default;
  const nextThemeLabel = THEME_LABELS[nextTheme];
  const handleToggleTheme = () => {
    const currentTheme = normalizeTheme(
      document.documentElement.dataset.theme || readTheme()
    );
    setTheme(applyTheme(currentTheme === "dark" ? "default" : "dark"));
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={theme === "dark"}
      onClick={handleToggleTheme}
      className="theme-switch tourney-theme-switch"
      aria-label={`Switch to ${nextThemeLabel} theme. Current theme: ${themeLabel}`}
      title={`Theme: ${themeLabel} - switch to ${nextThemeLabel}`}
    >
      <span className="theme-switch-track" aria-hidden="true">
        <span className="theme-switch-icon theme-switch-icon-default">
          <Tv />
        </span>
        <span className="theme-switch-icon theme-switch-icon-dark">
          <Moon />
        </span>
        <span className="theme-switch-thumb" />
      </span>
      <span className="tourney-sr-only">{`Switch to ${nextThemeLabel} theme`}</span>
    </button>
  );
}
