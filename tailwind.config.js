/** @type {import('tailwindcss').Config} */
const defaultTheme = require("tailwindcss/defaultTheme");

module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./app/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Roboto Flex Variable", ...defaultTheme.fontFamily.sans],
      },
      // Semantic theme tokens — values defined per-theme in src/index.css
      // (ROO INDUSTRIES THEME TOKENS). Note: these are CSS variables, so
      // Tailwind opacity modifiers (e.g. bg-accent/50) do NOT apply; use a
      // dedicated token instead.
      colors: {
        canvas: "var(--color-canvas)",
        "canvas-deep": "var(--color-canvas-deep)",
        surface: {
          DEFAULT: "var(--color-surface)",
          elevated: "var(--color-surface-elevated)",
          solid: "var(--color-surface-solid)",
          card: "var(--color-surface-card)",
          veil: "var(--color-surface-veil)",
          input: "var(--color-surface-input)",
          hover: "var(--color-surface-hover)",
          "hover-accent": "var(--color-surface-hover-accent)",
        },
        ink: {
          DEFAULT: "var(--color-text-primary)",
          secondary: "var(--color-text-secondary)",
          muted: "var(--color-text-muted)",
          display: "var(--color-text-display)",
        },
        accent: {
          DEFAULT: "var(--color-accent)",
          strong: "var(--color-accent-strong)",
          contrast: "var(--color-accent-contrast)",
          glow: "var(--color-accent-glow)",
          soft: "var(--color-accent-soft)",
        },
        line: {
          soft: "var(--color-border-soft)",
          strong: "var(--color-border-strong)",
          accent: "var(--color-border-accent)",
          input: "var(--color-border-input)",
        },
        success: {
          DEFAULT: "var(--color-success)",
          soft: "var(--color-success-soft)",
          border: "var(--color-success-border)",
          text: "var(--color-success-text)",
        },
        warning: {
          DEFAULT: "var(--color-warning)",
          soft: "var(--color-warning-soft)",
          border: "var(--color-warning-border)",
          text: "var(--color-warning-text)",
        },
        danger: {
          DEFAULT: "var(--color-danger)",
          soft: "var(--color-danger-soft)",
          border: "var(--color-danger-border)",
          text: "var(--color-danger-text)",
        },
        info: {
          DEFAULT: "var(--color-info)",
          soft: "var(--color-info-soft)",
          border: "var(--color-info-border)",
          text: "var(--color-info-text)",
        },
      },
      boxShadow: {
        "glow-soft": "var(--shadow-glow-soft)",
        "glow-strong": "var(--shadow-glow-strong)",
        "success-soft": "var(--shadow-success-soft)",
        "danger-soft": "var(--shadow-danger-soft)",
        "info-soft": "var(--shadow-info-soft)",
        surface: "var(--shadow-surface)",
        "surface-deep": "var(--shadow-surface-deep)",
      },
      backgroundImage: {
        "app-gradient": "var(--gradient-app-bg)",
        "button-primary": "var(--gradient-button-primary)",
        "button-booking": "var(--gradient-button-booking)",
        "platform-twitch": "var(--gradient-platform-twitch)",
        glass: "var(--gradient-glass)",
        skeleton: "var(--gradient-skeleton)",
        panel: "var(--gradient-panel)",
      },
    },
  },
  plugins: [],
};
