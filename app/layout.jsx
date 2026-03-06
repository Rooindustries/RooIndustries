import "../src/roboto-latin.css";
import "../src/index.css";
import seo from "@/src/lib/seo";

// Keep root metadata static at layout level so core tags appear immediately.
export const metadata = seo.getMetadataForPath("/");

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="preload"
          href="/fonts/roboto-flex-latin-opsz-normal.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
