(() => {
  if (!crypto.randomUUID) crypto.randomUUID = () => { const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128; const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`; };
  const cfg = window.__uiRepairsConfig || {};
  window.__uiErrors = [];
  window.__uiHydrationWarnings = [];
  window.addEventListener('error', event => { const message = String(event.error?.message || event.message); (message.startsWith('Hydration failed because') ? window.__uiHydrationWarnings : window.__uiErrors).push(message); });
  window.addEventListener('unhandledrejection', event => window.__uiErrors.push(String(event.reason?.message || event.reason)));
  for (const [key, value] of Object.entries(cfg.seed || {})) sessionStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  const denied = () => { throw new DOMException('Synthetic optional storage denied', 'SecurityError'); };
  const stores = location.pathname === '/' ? ['localStorage'] : ['sessionStorage'];
  const realStores = Object.fromEntries(stores.map(name => [name, window[name]]));
  const failures = {};
  window.__uiDenyStorage = mode => {
    if (!mode) for (const key of Object.keys(failures)) delete failures[key];
    for (const name of stores) {
      if (mode === 'property') { Object.defineProperty(window, name, { configurable: true, get: denied }); continue; }
      if (mode) failures[mode === 'quota' ? 'setItem' : mode] = mode;
      const target = realStores[name];
      const wrapper = new Proxy(target, { get: (storage, key) => {
        if (failures[key]) return () => { if (failures[key] === 'quota') throw new DOMException('Synthetic quota exceeded', 'QuotaExceededError'); return denied(); };
        const value = Reflect.get(storage, key, storage); return typeof value === 'function' ? value.bind(storage) : value;
      } });
      Object.defineProperty(window, name, { configurable: true, value: wrapper });
    }
  };
  window.__uiDenyStorage(cfg.denial);
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
    if (url.origin === 'https://formspree.io') return originalFetch(`/__ui/formspree?form=${encodeURIComponent(url.pathname.split('/').pop())}`, init);
    if (url.origin !== location.origin) return Promise.reject(new Error('Fixture refuses external browser fetch'));
    return originalFetch(input, init);
  };
  const originalMatchMedia = window.matchMedia.bind(window);
  const reduce = originalMatchMedia('(prefers-reduced-motion: reduce)');
  let reduced = reduce.matches;
  Object.defineProperty(reduce, 'matches', { get: () => reduced });
  window.matchMedia = query => query === '(prefers-reduced-motion: reduce)' ? reduce : originalMatchMedia(query);
  window.__uiReducedMotion = value => { reduced = value; reduce.dispatchEvent(new MediaQueryListEvent('change', { matches: value, media: reduce.media })); };
  const script = document.currentScript;
  script?.previousElementSibling?.remove();
  script?.remove();
})();
