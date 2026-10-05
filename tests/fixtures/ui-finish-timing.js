(() => {
  const w = document.getElementById('app')?.contentWindow || window;
  const d = w.document;
  const records = [];
  let active;
  let raf;
  let timer;
  const sample = (kind, timestamp = w.performance.now()) => {
    if (!active) return;
    const target = d.querySelector(active.hash);
    const top = target?.getBoundingClientRect().top;
    const placeholders = [...d.querySelectorAll('[data-section-placeholder]')].filter(node => target && (target.contains(node) || (node.compareDocumentPosition(target) & w.Node.DOCUMENT_POSITION_FOLLOWING))).map(node => node.id || node.tagName);
    active.samples.push({ kind, ms: Math.round(timestamp - active.clickedAt), top: Math.round(top ?? 9999), documentTop: Math.round((top ?? 9999) + w.scrollY), scrollY: Math.round(w.scrollY), placeholders });
  };
  const tick = ts => { sample('frame', ts); if (active) raf = w.requestAnimationFrame(tick); };
  const observer = new w.MutationObserver(changes => { if (active) { active.mutations += changes.length; sample('mutation'); } }); observer.observe(d.body, { childList: true, subtree: true });
  if (w.PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    const longtasks = new w.PerformanceObserver(list => { if (active) active.longtasks.push(...list.getEntries().map(entry => ({ start: Math.round(entry.startTime - active.clickedAt), duration: Math.round(entry.duration) }))); }); longtasks.observe({ type: 'longtask' });
  }
  d.addEventListener('click', event => {
    const link = event.target.closest('a.book-optimization-button, a.fps-boosts-button'); if (!link || !active) return;
    Object.assign(active, { clickedAt: w.performance.now(), trusted: event.isTrusted, name: link.textContent.trim(), visibility: d.visibilityState, hidden: d.hidden, focus: d.hasFocus(), width: w.innerWidth, ua: w.navigator.userAgent, touchPoints: w.navigator.maxTouchPoints }); sample('click'); raf = w.requestAnimationFrame(tick); timer = w.setInterval(() => { if (active) active.timers.push(Math.round(w.performance.now() - active.clickedAt)); }, 100);
  }, true);
  w.addEventListener('roo:section-align-settled', event => {
    if (!active) return; sample('settled'); Object.assign(active, { settledHash: event.detail?.hash, elapsedFromProbeMs: Math.round(w.performance.now() - active.startedAt), elapsedFromClickMs: Math.round(w.performance.now() - active.clickedAt) });
    w.cancelAnimationFrame(raf); w.clearInterval(timer); records.push(active); active = null;
  });
  window.__uiFinishTiming = {
    records,
    install: hash => { active = { hash, startedAt: w.performance.now(), samples: [], timers: [], longtasks: [], mutations: 0 }; return { installed: true, hash, ua: w.navigator.userAgent, width: w.innerWidth, visibility: d.visibilityState, hidden: d.hidden, focus: d.hasFocus() }; },
    top: () => { const root = d.documentElement; const previous = root.style.scrollBehavior; root.style.scrollBehavior = 'auto'; w.scrollTo({ top: 0, behavior: 'auto' }); root.style.scrollBehavior = previous; return w.scrollY; },
    save: async scenario => { const value = { scenario, phase: 'after', complete: true, records, ua: w.navigator.userAgent, width: w.innerWidth, visibility: d.visibilityState, hidden: d.hidden, focus: d.hasFocus() }; await fetch('/__ui/finish-evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); return value; }
  };
  return { installed: true };
})()
