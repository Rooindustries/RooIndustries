(() => {
  const app = document.getElementById('app')?.contentWindow || window;
  const d = app.document;
  const records = [];
  let pending;
  const state = () => ({ route: app.location.pathname, focus: d.activeElement === d.body ? 'body' : (d.activeElement?.textContent?.trim().slice(0,120) || d.activeElement?.getAttribute('aria-label')), focusInPlan: !!d.activeElement?.closest('[aria-labelledby="booking-plan-title"]'), planOpen: !!d.querySelector('[aria-labelledby="booking-plan-title"]'), dialogs: d.querySelectorAll('[role=dialog]').length, hiddenFocus: !!d.activeElement?.closest('[inert], [aria-hidden="true"]') });
  d.addEventListener('click', event => {
    const link = event.target.closest('a.book-optimization-button, a.fps-boosts-button');
    if (link) {
      pending = { kind: 'cta', name: link.textContent.trim(), trusted: event.isTrusted, started: app.performance.now(), width: app.innerWidth };
      records.push(pending);
    } else if (event.target === d.querySelector('[aria-labelledby="booking-plan-title"]')?.parentElement) {
      const record = { kind: 'plan-backdrop', trusted: event.isTrusted }; records.push(record); setTimeout(() => Object.assign(record, state()), 700);
    }
  }, true);
  app.addEventListener('roo:section-align-settled', event => {
    if (!pending) return;
    const hash = event.detail?.hash || '';
    Object.assign(pending, { hash, top: Math.round(d.querySelector(hash)?.getBoundingClientRect().top ?? 9999), elapsedMs: Math.round(app.performance.now() - pending.started) });
    pending.ok = pending.trusted && Math.abs(pending.top) <= 160 && pending.elapsedMs <= 600;
    pending = null;
  });
  d.addEventListener('keydown', event => {
    if (!['Tab','Escape'].includes(event.key)) return;
    const record = { kind: 'keyboard', key: event.key, shift: event.shiftKey, trusted: event.isTrusted }; records.push(record);
    setTimeout(() => Object.assign(record, state()), event.key === 'Escape' ? 700 : 0);
  }, true);
  window.__uiNative = { records, state, save: async (scenario, additional = {}) => {
    const value = { phase: 'after', scenario, complete: true, results: records, final: state(), ...additional };
    await fetch('/__ui/repairs-evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); return value;
  } };
  return { installed: true, width: app.innerWidth, ...state() };
})()
