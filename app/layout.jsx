import "../src/roboto-latin.css";
import "../src/index.css";
import seo from "@/src/lib/seo";
import AppClientRuntime from "@/src/next/AppClientRuntime";
import envValue from "@/src/server/supabase/envValue.cjs";

export const metadata = seo.getMetadataForPath("/");
const SUPABASE_ASSET_ORIGIN =
  "https://ntezmxzaibrrsgtujgxu.supabase.co";
const { normalizeBackend, readEnvValue } = envValue;
const shouldPreconnectSupabase =
  normalizeBackend(
    readEnvValue(process.env, "DATA_PRIMARY_BACKEND"),
    "supabase"
  ) === "supabase" ||
  Number(readEnvValue(process.env, "SUPABASE_CONTENT_CANARY_PERCENT") || 0) > 0;

const themeInitScript = `
(function() {
  try {
    var root = document.documentElement;
    var key = "roo-theme";
    var stored = window.localStorage ? window.localStorage.getItem(key) : null;
    var theme = stored === "dark" ? "dark" : "default";
    root.dataset.theme = theme;
    if (stored !== "dark" && stored !== "default" && stored !== null && window.localStorage) {
      window.localStorage.setItem(key, theme);
    }
    var themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      themeMeta.setAttribute("content", theme === "dark" ? "#070707" : "#000040");
    }
  } catch (_) {
    document.documentElement.dataset.theme = "default";
  }
})();
`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#000040" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {shouldPreconnectSupabase ? (
          <>
            <link
              rel="preconnect"
              href={SUPABASE_ASSET_ORIGIN}
              crossOrigin="anonymous"
            />
            <link rel="dns-prefetch" href={SUPABASE_ASSET_ORIGIN} />
          </>
        ) : null}
        <link
          rel="preload"
          href="/fonts/manrope-latin-variable.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/favicon-96x96.png"
          as="image"
          type="image/png"
        />
      </head>
      <body>
        <AppClientRuntime />
        {children}
      </body>
    </html>
  );
}
