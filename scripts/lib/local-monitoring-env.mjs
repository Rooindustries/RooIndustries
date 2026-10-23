export function localMonitoringEnv(env, dsn = "") {
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) =>
    !/SENTRY.*DSN/i.test(name) && name !== "VERCEL" && name !== "NEXT_PUBLIC_SENTRY_HOSTED"));
  clean.NEXT_PUBLIC_SENTRY_DSN = "";
  try {
    const url = new URL(dsn);
    if (["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      clean.NEXT_PUBLIC_SENTRY_DSN = url.href;
    }
  } catch {}
  return clean;
}
