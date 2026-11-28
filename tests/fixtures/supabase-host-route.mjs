const target = new URL(process.env.ROO_TEST_SUPABASE_ORIGIN);
const fetchThroughGuard = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (typeof input !== 'string' && !(input instanceof URL)) return fetchThroughGuard(input, init);
  const url = new URL(input);
  if (url.origin === 'https://ntezmxzaibrrsgtujgxu.supabase.co') {
    url.protocol = target.protocol;
    url.host = target.host;
  }
  return fetchThroughGuard(url, init);
};
