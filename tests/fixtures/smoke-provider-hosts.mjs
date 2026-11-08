const send = globalThis.fetch;
const fixture = new URL(process.env.SMOKE_PROVIDER_FIXTURE);

globalThis.fetch = (input, options) => {
  const url = new URL(input);
  if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return send(input, options);
  }
  const target = new URL(fixture);
  target.pathname = url.pathname;
  target.search = url.search;
  return send(target, { ...options, headers: { ...options?.headers, "x-fixture-host": url.hostname } });
};
