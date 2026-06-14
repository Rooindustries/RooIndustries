import "../src/roboto-latin.css";
import "../src/index.css";
import seo from "@/src/lib/seo";

// Keep root metadata static at layout level so core tags appear immediately.
export const metadata = seo.getMetadataForPath("/");

const seorceProjectId = "6a2e76bf3f9dac8c30e27b89";

// Two themes only: "default" (Roo Blue) and "dark" (Blackout). Legacy
// stored values ("light"/"system") normalize to default.
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
        <script
          src={`https://scripts.seorce.com/api?projectId=${seorceProjectId}`}
          defer
          data-uuid={seorceProjectId}
        />
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
      <body>{children}</body>
    </html>
  );
}
