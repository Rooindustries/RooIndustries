export const SITE_NAME = "Roo Industries";
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.REACT_APP_SITE_URL ||
  "https://www.rooindustries.com").replace(/\/$/, "");
export const DEFAULT_TITLE = `${SITE_NAME} | PC Game Optimization`;
export const DEFAULT_DESCRIPTION =
  "Remote PC game optimization for competitive players who want more FPS, lower input lag, cleaner frametimes, and stable performance in the games they play.";
export const DEFAULT_OG_IMAGE = `${SITE_URL}/embed_logo.png`;

export const resolveUrl = (value) => {
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `${SITE_URL}${value.startsWith("/") ? "" : "/"}${value}`;
};
