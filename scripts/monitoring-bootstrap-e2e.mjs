import { registerHooks } from 'node:module';

export async function checkBrowserBootstrap(check) {
  const originalWindow = globalThis.window;
  const originalDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  const key = Symbol.for('roo.monitoring.bootstrap');
  const adapter = `data:text/javascript,${encodeURIComponent(`export function startBrowserMonitoring() {
    const state = globalThis[Symbol.for('roo.monitoring.bootstrap')];
    state.starts++;
    if (state.failStarts-- > 0) throw new Error('Fixture initialization failure');
    return { captureException: error => state.captured.push(error) };
  }`)}`;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === './browser' && context.parentURL?.includes('/src/lib/monitoring/client.js?bootstrap=')) {
        const state = globalThis[key];
        state.imports++;
        if (state.failImports-- > 0) throw new Error('Fixture missing chunk');
        return { url: adapter, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
  const waitFor = async (predicate, limit = 3500) => {
    for (let elapsed = 0; elapsed < limit; elapsed += 25) {
      if (predicate()) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return predicate();
  };
  const fire = error => {
    const event = new Event('unhandledrejection');
    Object.defineProperty(event, 'reason', { value: error });
    window.dispatchEvent(event);
  };
  try {
    for (const [name, options] of [
      ['import-recovery', { failImports: 1 }],
      ['initialization-recovery', { failStarts: 1 }],
      ['permanent-chunk', { failImports: Infinity }],
      ['disabled', { disabled: true }],
    ]) {
      const state = { imports: 0, starts: 0, captured: [], failImports: 0, failStarts: 0, ...options };
      globalThis[key] = state;
      globalThis.window = new EventTarget();
      process.env.NEXT_PUBLIC_SENTRY_DSN = state.disabled ? '' : originalDsn;
      const client = await import(`../src/lib/monitoring/client.js?bootstrap=${name}`);
      client.watchWindowErrors();
      check(`${name}: no browser SDK work before the first error`, [state.imports, state.starts], [0, 0]);
      const errors = Array.from({ length: 12 }, (_, index) => new Error(`Fixture bootstrap ${index}`));
      if (name === 'permanent-chunk') {
        for (const error of errors) fire(error);
        await waitFor(() => state.imports >= 3);
        await new Promise(resolve => setTimeout(resolve, 500));
        check('permanent chunks stop after three single-flight attempts', [state.imports, state.starts, state.captured.length], [3, 0, 0]);
        state.failImports = 0;
        client.reportClientError(new Error('Fixture recovery after exhaustion'));
        await waitFor(() => state.captured.length > 0);
        check('a later boundary error retries the original bounded queue', [state.imports, state.captured.length, state.captured.every((error, index) => error === errors[index])], [4, 10, true]);
      } else if (name === 'disabled') {
        fire(errors[0]);
        client.reportClientError(errors[1]);
        await new Promise(resolve => setTimeout(resolve, 600));
        check('disabled monitoring never loads the SDK', [state.imports, state.starts, state.captured.length], [0, 0, 0]);
      } else {
        fire(errors[0]);
        await waitFor(() => state.captured.length > 0);
        check(`${name}: the first rejection arrives without a second event`, [state.imports, state.starts, state.captured.length, state.captured[0] === errors[0]], [2, name === 'initialization-recovery' ? 2 : 1, 1, true]);
      }
    }
  } finally {
    hooks.deregister();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalDsn === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    else process.env.NEXT_PUBLIC_SENTRY_DSN = originalDsn;
    delete globalThis[key];
  }
}
