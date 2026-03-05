import "../src/roboto-latin.css";
import "../src/index.css";

const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "https://www.rooindustries.com").replace(/\/$/, "");

export const metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Roo Industries | Professional PC Optimization",
    template: "%s",
  },
  description:
    "World-class PC optimization, BIOS tuning, and game performance boosts delivered fully online.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head />
      <body>{children}</body>
    </html>
  );
}
