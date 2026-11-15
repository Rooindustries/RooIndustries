import "../src/roboto-latin.css";
import "../src/index.css";
import "../src/styles/sections.css";
import seo from "@/src/lib/seo";
import AppClientRuntime from "@/src/next/AppClientRuntime";
import { PublicContentProvider } from "@/src/next/PublicContentContext";
import contentServer from "@/src/lib/contentServer";
import { getSupabaseAssetOrigin } from "../next.config.mjs";
import envValue from "@/src/server/supabase/envValue.cjs";

export const metadata = seo.getMetadataForPath("/");
const SUPABASE_ASSET_ORIGIN = getSupabaseAssetOrigin();
const { normalizeBackend, readEnvValue, readOutsideEnvValue } = envValue;
const shouldPreconnectSupabase = Boolean(SUPABASE_ASSET_ORIGIN) && (
  normalizeBackend(
    readOutsideEnvValue(process.env, "DATA_PRIMARY_BACKEND"),
    "supabase"
  ) === "supabase" ||
  Number(readEnvValue(process.env, "SUPABASE_CONTENT_CANARY_PERCENT") || 0) > 0);

const themeInitScript = `
(function() {
  document.documentElement.classList.add("js");
  try {
    var root = document.documentElement;
    var key = "roo-theme";
    var stored = window.localStorage ? window.localStorage.getItem(key) : null;
    var theme = stored === "default" ? "default" : "dark";
    root.dataset.theme = theme;
    if (stored !== "dark" && stored !== "default" && stored !== null && window.localStorage) {
      window.localStorage.setItem(key, theme);
    }
    var themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      themeMeta.setAttribute("content", theme === "dark" ? "#070707" : "#000040");
    }
  } catch (_) {
    document.documentElement.dataset.theme = "dark";
  }
})();
`;

export default async function RootLayout({ children }) {
  const discordBanner = await contentServer.fetchDiscordBanner();
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#070707" />
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
        <a className="skip-to-content" href="#main-content">
          Skip to content
        </a>
        <AppClientRuntime />
        <PublicContentProvider discordBanner={discordBanner}>{children}</PublicContentProvider>
      </body>
    </html>
  );
}
