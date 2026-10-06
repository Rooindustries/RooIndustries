const fs = require('fs'), path = require('path');
const root = process.cwd();
const parser = require(path.join(root, 'node_modules/@babel/parser'));
const traverse = require(path.join(root, 'node_modules/@babel/traverse')).default;
const known = new Set(`undefined NaN Infinity globalThis window document navigator location history localStorage sessionStorage console process Buffer require module exports __dirname __filename setTimeout clearTimeout setInterval clearInterval setImmediate clearImmediate queueMicrotask structuredClone fetch Request Response Headers URL URLSearchParams AbortController AbortSignal TextEncoder TextDecoder crypto performance Blob File FormData ReadableStream WritableStream TransformStream Event EventTarget CustomEvent atob btoa Intl Promise Symbol Map Set WeakMap WeakSet WeakRef Proxy Reflect JSON Math Date RegExp Error TypeError RangeError SyntaxError EvalError ReferenceError AggregateError Array Object String Number Boolean BigInt Function ArrayBuffer SharedArrayBuffer DataView Uint8Array Int8Array Uint16Array Int16Array Uint32Array Int32Array Float32Array Float64Array BigInt64Array BigUint64Array Uint8ClampedArray parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI escape unescape eval Atomics WebAssembly XMLHttpRequest Image HTMLElement Element Node NodeList MutationObserver IntersectionObserver ResizeObserver requestAnimationFrame cancelAnimationFrame requestIdleCallback cancelIdleCallback getComputedStyle matchMedia alert confirm prompt open close focus scroll scrollTo innerWidth innerHeight devicePixelRatio KeyboardEvent MouseEvent PointerEvent TouchEvent MessageChannel BroadcastChannel Worker ServiceWorker caches indexedDB DOMException DOMParser Range Selection CSS FileReader FileList Storage SVGElement HTMLInputElement HTMLTextAreaElement HTMLImageElement HTMLDivElement React reportError`.split(/\s+/));
const exts = /\.(js|jsx|ts|tsx|mjs|cjs)$/;
const files = [];
const collect = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.next', '.git', 'test-results', 'audit'].includes(e.name)) continue; const f = path.join(d, e.name); if (e.isDirectory()) collect(f); else if (exts.test(f)) files.push(f); } };
for (const d of (process.argv.slice(2).length ? process.argv.slice(2) : ['src', 'app', 'scripts', 'tests'])) if (fs.existsSync(d)) collect(d);
for (const f of ['middleware.js', 'next.config.mjs']) if (fs.existsSync(f)) files.push(f);
const out = [];
for (const file of files) {
  let src; try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
  let ast;
  try { ast = parser.parse(src, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx', 'importAttributes', ...(/\.tsx?$/.test(file) ? ['typescript'] : [])] }); } catch (e) { out.push({ file, parseError: e.message }); continue; }
  try {
    traverse(ast, { Program(p) {
      const g = p.scope.globals; const references = new Map(); p.traverse({ Identifier(identifier) { if (g[identifier.node.name] === identifier.node) references.set(identifier.node.name, identifier); } });
      const names = Object.keys(g).filter(n => {
        if (known.has(n) || n === 'global' || n === 'PerformanceObserver' || n === 'scrollY' || n === 'MediaQueryListEvent') return false;
        if (/(__tests__|\.test\.|setupTests)/.test(file) && ['jest','describe','test','it','expect','beforeEach','afterEach','beforeAll','afterAll','xdescribe','xtest','xit','fit','fdescribe'].includes(n)) return false;
        if (n === 'arguments' && references.get(n)?.findParent(parent => parent.isFunction() && !parent.isArrowFunctionExpression())) return false;
        if (/\.tsx?$/.test(file) && references.get(n)?.findParent(parent => parent.type.startsWith('TS') && !['TSAsExpression','TSNonNullExpression','TSSatisfiesExpression'].includes(parent.type))) return false;
        return true;
      });
      if (names.length) out.push({ file, undefined: names.map(n => `${n}@${g[n].loc?.start.line}`) });
    } });
  } catch (e) { out.push({ file, traverseError: e.message }); }
}
const artifact = { passed: out.length === 0, startedAt: new Date().toISOString(), files: files.length, parser: require('@babel/parser/package.json').version, issues: out, legitimateGlobals: ['global (Node)', 'PerformanceObserver/scrollY/MediaQueryListEvent (browser)', 'arguments inside ordinary functions', 'Jest globals only in test/setup files', 'TypeScript type syntax'] };
fs.mkdirSync('test-results/sanity-fixround', { recursive: true }); fs.writeFileSync('test-results/sanity-fixround/undefined-identifiers.json', JSON.stringify(artifact, null, 2) + '\n'); console.log(JSON.stringify(artifact)); if (!artifact.passed) process.exitCode = 1;
