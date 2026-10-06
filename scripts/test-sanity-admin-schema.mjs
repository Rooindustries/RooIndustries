import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { CONTENT_TYPES, validateContentDocument, createContentDefaults, PORTABLE_TEXT_DEFAULTS } from '../src/lib/cms/contentSchema.js';
import { uiRepairsFixture } from '../tests/fixtures/ui-repairs-server.mjs';
const scenario = process.argv.find(arg => arg.startsWith('--scenario='))?.slice(11) || 'schema';
assert.equal(scenario, 'schema');
const artifact = { scenario, startedAt: new Date().toISOString(), checks: [], fieldComparison: [], fixtureShapes: [], fixtureLimit: 'Synthetic local fixtures, not hosted documents; validates raw stored shapes with current supplied.' };
const check = (name, callback) => { callback(); artifact.checks.push({ name, passed: true }); };
try {
  const snapshot = JSON.parse(fs.readFileSync('scripts/fixtures/cms-schema-contract.json', 'utf8'));
  check('exact-24-types-and-17-singletons', () => { assert.equal(CONTENT_TYPES.length, 24); assert.equal(CONTENT_TYPES.filter(s => s.singleton).length, 17); assert.deepEqual(CONTENT_TYPES, snapshot.schemas); });
  const flatten = (fields, prefix = '') => fields.flatMap(f => [{ field: prefix + (f.name || f.type), type: f.type }, ...flatten(f.fields || f.of || [], prefix + (f.name || f.type) + '.')]);
  for (const schema of CONTENT_TYPES) {
    const file = `rooindustries/schemaTypes/${schema.name === 'faqSection' ? 'faq' : schema.name}.js`;
    if (fs.existsSync(file)) {
      const source = fs.readFileSync(file, 'utf8');
      const context = {};
      vm.runInNewContext(source.replace(/export default /, 'globalThis.schema = ').replace(/export const /g, 'const '), context);
      const convert = (field, fieldPath) => {
        const result = {};
        for (const [key, value] of Object.entries(field)) {
          if (key === 'validation') {
            const rule = new Proxy({}, { get(_, method) { return (...args) => { if (method === 'custom') result.customRule = fieldPath; else if (method === 'warning') result.warning = args[0]; else result[method] = args.length ? args[0] : true; return rule; }; } });
            value(rule);
          } else if (key === 'to') result.to = value.map(item => item.type);
          else if (key === 'fields' || key === 'of') result[key] = value.map((item, index) => convert(item, `${fieldPath}.${item.name || index}`));
          else if (key === 'preview') result.preview = value.select || {};
          else if (typeof value === 'function') result[key + 'Rule'] = value.toString();
          else result[key] = value;
        }
        if (field.type === 'url') result.schemes = ['http', 'https'];
        if (field.type === 'block') {
          result.styles = PORTABLE_TEXT_DEFAULTS.styles; result.lists = PORTABLE_TEXT_DEFAULTS.lists; result.decorators = PORTABLE_TEXT_DEFAULTS.decorators;
          result.annotations = [{ name: 'link', type: 'object', fields: [{ name: 'href', title: 'URL', type: 'url', schemes: ['http', 'https', 'mailto', 'tel'], allowRelative: true }] }];
        }
        return result;
      };
      assert.deepEqual(JSON.parse(JSON.stringify(context.schema.fields.map(field => convert(field, `${schema.name}.${field.name}`)))), schema.fields);
      artifact.fieldComparison.push({ type: schema.name, file, sha256: crypto.createHash('sha256').update(source).digest('hex'), fields: flatten(schema.fields), matched: true });
    }
  }
  const input = fs.readFileSync('tests/fixtures/tooling-content.mjs', 'utf8');
  const section = input.slice(input.indexOf('  const document ='), input.indexOf('  const evidence ='));
  const fixture = uiRepairsFixture({ base: 'http://127.0.0.1:1' });
  const context = { content: resource => fixture.content(resource, new URL('http://127.0.0.1:1')) };
  vm.runInNewContext(section + '\nglobalThis.fixtureDocuments = documents;', context);
  for (const doc of JSON.parse(JSON.stringify(context.fixtureDocuments))) artifact.fixtureShapes.push({ id: doc._id, type: doc._type, result: validateContentDocument(doc._type, doc, { current: doc }) });
  check('unknown-stored-field-retained-new-or-changed-refused', () => {
    const current = { headingLine1: 'Before', untouched: { nested: ['original'] } };
    assert.equal(validateContentDocument('hero', { ...current, headingLine1: 'After' }, { current }).ok, true);
    assert.equal(validateContentDocument('hero', { ...current, untouched: 'changed' }, { current }).ok, false);
    assert.equal(validateContentDocument('hero', { newField: 1 }).ok, false);
  });
  check('all-portabletext-defaults-roundtrip', () => {
    const blocks = PORTABLE_TEXT_DEFAULTS.styles.flatMap((style, i) => [undefined, ...PORTABLE_TEXT_DEFAULTS.lists].map((listItem, j) => ({ _key: `block${i}${j}`, _type: 'block', style, ...(listItem ? { listItem, level: 2 } : {}), markDefs: [{ _type: 'link', _key: 'link', href: 'https://fixture.invalid' }], children: [{ _key: 'span', _type: 'span', text: 'Synthetic', marks: [...PORTABLE_TEXT_DEFAULTS.decorators, 'link'] }] })));
    const doc = { sections: [{ _key: 'section', heading: 'Synthetic', content: blocks }] };
    const before = JSON.stringify(doc);
    assert.deepEqual(validateContentDocument('terms', doc), { ok: true, errors: [] });
    assert.equal(JSON.stringify(doc), before);
  });
  check('field-types-required-bounds-options-conditional', () => {
    for (const [type, doc] of [['package', { title: 'Synthetic', price: '$0' }], ['package', { title: 'Synthetic', price: '$12', order: 0 }], ['coupon', { title: 'Synthetic', code: 'a', discountType: 'fixed', discountAmount: 0 }], ['tool', { title: 'Synthetic', downloadMode: 'hosted' }], ['siteSettings', { siteMode: 'other' }], ['supportedGames', { featuredGames: Array.from({ length: 7 }, (_, i) => ({ _key: `k${i}` })) }], ['bookingSettings', { ownerEmail: 'broken' }], ['hero', { bullets: [12] }]]) assert.equal(validateContentDocument(type, doc).ok, false, type);
    assert.equal(validateContentDocument('package', { title: 'Synthetic', price: '$12.34', order: 1 }).ok, true);
    assert.equal(validateContentDocument('coupon', { title: 'Synthetic', code: 'okay', discountType: 'percent', discountPercent: 10, timesUsed: 'ignored' }).ok, true);
    assert.equal(createContentDefaults('bookingSettings').maxDaysAheadBooking, 7);
  });
  artifact.passed = true;
} catch (error) { artifact.passed = false; artifact.error = error.stack; process.exitCode = 1; }
artifact.finishedAt = new Date().toISOString();
fs.mkdirSync('test-results/sanity-admin', { recursive: true });
fs.writeFileSync(path.resolve('test-results/sanity-admin/schema.json'), JSON.stringify(artifact, null, 2) + '\n');
console.log(JSON.stringify({ passed: artifact.passed, checks: artifact.checks.length, types: artifact.fieldComparison.length, fixtureShapes: artifact.fixtureShapes.length, invalidFixtures: artifact.fixtureShapes.filter(x => !x.result.ok).map(x => ({ id: x.id, errors: x.result.errors })), error: artifact.error }));
