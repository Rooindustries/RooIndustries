const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const parseToolDownloadsOrigin = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) return null;
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
};

module.exports = { parseToolDownloadsOrigin };
