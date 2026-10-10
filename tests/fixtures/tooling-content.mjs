import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { uiRepairsFixture } from './ui-repairs-server.mjs';
import { localOrigin } from '../../scripts/lib/test-target-safety.mjs';

export async function createToolingContentFixture({ origin, artifact }) {
  const target = new URL(localOrigin(origin));
  const reused = uiRepairsFixture({ base: origin });
  const content = resource => reused.content(resource, target);
  const document = (type, data, id = `tooling-${type}`) => ({ ...data, _type: type, _id: id, _rev: 'tooling-fixture-v1', _createdAt: '2026-01-01T00:00:00Z', _updatedAt: '2026-01-01T00:00:00Z' });
  const paragraph = 'This is synthetic privacy content for an isolated local Roo Industries application test. The fixture describes how example contact details, booking preferences, and browser settings may be represented on a policy page. All names and addresses in this fixture are invented. This content is used only to verify server rendering, heading structure, paragraph visibility, content negotiation, and client hydration. It does not describe an actual customer, a live account, or a production data collection practice. No real messages, payments, credentials, or account changes are performed by this fixture. A reader can use the local contact route to inspect the application navigation without sending a message.';
  const reviews = content('reviews');
  if (process.env.TOOLING_REVIEW_COUNT) reviews.reviews = reviews.reviews.slice(0, Number(process.env.TOOLING_REVIEW_COUNT));
  const policy = title => ({ title, sections: [{ heading: 'Synthetic local information', content: [{ _type: 'block', _key: 'privacy-body', style: 'normal', markDefs: [], children: [{ _type: 'span', _key: 'privacy-span', text: paragraph, marks: [] }] }] }] });
  const privacy = policy('Privacy Policy');
  privacy.sections.push({
    heading: 'Synthetic line breaks',
    content: [
      {
        _type: 'block',
        _key: 'privacy-line-breaks',
        style: 'normal',
        markDefs: [],
        children: [{ _type: 'span', _key: 'privacy-line-breaks-span', text: 'Synthetic first line:\n\n- Synthetic item one\n- Synthetic item two\n\nSynthetic closing line &copy;.', marks: [] }],
      },
      {
        _type: 'block',
        _key: 'privacy-list-line-breaks',
        style: 'normal',
        listItem: 'bullet',
        level: 1,
        markDefs: [],
        children: [{ _type: 'span', _key: 'privacy-list-line-breaks-span', text: 'List line one\nList line two', marks: [] }],
      },
      {
        _type: 'block',
        _key: 'privacy-lf-line-breaks',
        style: 'normal',
        markDefs: [],
        children: [{ _type: 'span', _key: 'privacy-lf-line-breaks-span', text: '\nLeading break\n\n\nThree breaks\rcarriage return\n\n', marks: [] }],
      },
    ],
  });
  const documents = [
    document('hero', {
      tagline: '',
      headingLine1: 'Fixture Hero Heading One',
      headingLine2: 'Fixture Hero Heading Two',
      description: 'Synthetic hero description served by the local content fixture.\n========================',
      subtext: '1) Synthetic hero subtext with *literal* asterisks &amp; :fire: $5.',
      ctaPrimaryText: 'Tune My PC',
      ctaSecondaryText: 'How It Works',
      ctaNote: 'Fixture note one with extra words · Fixture note two with extra words',
      headingData1: 'Legacy Field Must Not Render',
      ctaNoteIcon: 'X',
      bullets: ['Fixture bullet'],
    }),
    ...content('packages-list').map((pkg, index) => document('package', { ...pkg, price: index === 1 ? '$149.95' : pkg.price, order: index }, `tooling-package-${index}`)),
    document('proReviewsCarousel', reviews),
    document('supportedGames', content('supported-games')),
    document('faqSettings', content('faq-settings')),
    document('faqSection', { questions: [...content('faq-questions'), ...Array.from({ length: 12 }, (_, index) => ({ _key: `tooling-question-${index}`, question: `Synthetic local question ${index + 1}`, answer: `This synthetic answer verifies that question ${index + 1} appears in the server-rendered FAQ without requiring a browser content request.` }))] }, 'faq'),
    document('privacyPolicy', privacy),
    document('terms', policy('Terms of Service')),
    document('contact', { title: 'Get In Touch', formId: '' }),
    document('about', { recordTitle: 'Synthetic local results', recordSubtitle: 'Local fixture content', recordDetails: [] }),
    document('services', { heading: 'Synthetic benefits', cards: [] }),
    document('howItWorks', { title: 'How It Works', steps: [] }),
    document('packagesSettings', {}),
    document('meetTheTeam', { heroTitle: 'Meet the Team', heroSubtitle: 'Synthetic local team', showFounder: false, sections: [] }),
    document('bookingSettings', { dateSlots: [{ date: '2099-01-05', times: ['10:00', '11:00'] }], xocDateSlots: [], vertexEssentialsDateSlots: [], packageDateSlots: [] }, '6d8a3646-0ed2-44b5-ad45-c5c9d578126a'),
  ];
  const evidence = { origin, pid: process.pid, contentSha256: createHash('sha256').update(JSON.stringify(documents)).digest('hex'), documentTypes: [...new Set(documents.map(row => row._type))], requests: [], stopped: false, standIn: 'Synthetic read-only HTTP responses shaped as the current PostgREST RPC contract. Actual Supabase SDK and GROQ evaluator execute. No PostgreSQL, hosted PostgREST, Sanity, GoTrue, provider or persistence equivalence is claimed.' };
  const persist = () => { if (artifact) { fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, JSON.stringify(evidence, null, 2) + '\n'); } };
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 131072) throw new Error('Fixture body is too large.'); }
      const body = raw ? JSON.parse(raw) : {};
      const call = { method: req.method, path: url.pathname, body, status: 503, rows: 0 };
      evidence.requests.push(call);
      if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_fetch_shadow_documents_targeted') {
        if (!Array.isArray(body.p_document_types) || !body.p_document_types.length || !Array.isArray(body.p_filters) || !Number.isInteger(body.p_limit) || body.p_limit < 1 || body.p_limit > 1000 || body.p_ids !== null && !Array.isArray(body.p_ids)) throw new Error('Invalid fixture read scope.');
        let rows = documents.filter(row => body.p_document_types.includes(row._type) && (!body.p_ids || body.p_ids.includes(row._id)));
        for (const filter of body.p_filters) {
          if (!['eq', 'ieq', 'in'].includes(filter.op) || typeof filter.path !== 'string') throw new Error('Unsupported fixture filter.');
          rows = rows.filter(row => { const value = filter.path.split('.').reduce((item, key) => item?.[key], row); return filter.op === 'in' ? Array.isArray(filter.value) && filter.value.includes(value) : filter.op === 'ieq' ? String(value).toLowerCase() === String(filter.value).toLowerCase() : value === filter.value; });
        }
        rows = rows.sort((a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0).slice(0, body.p_limit); call.status = 200; call.rows = rows.length; json(res, 200, rows);
      } else if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_asset_manifest_for_refs') {
        call.status = 200; json(res, 200, []);
      } else if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_fetch_commerce_availability') {
        call.status = 200; json(res, 200, { bookings: [], holds: [], slotLocks: [] });
      } else {
        json(res, 503, { code: 'FIXTURE_READ_ONLY', message: 'Synthetic content fixture refuses this operation.' });
      }
      persist();
    } catch (error) { json(res, 400, { code: 'FIXTURE_INPUT_INVALID', message: error.message }); persist(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(target.port), target.hostname, resolve); });
  persist();
  return { evidence, close: () => new Promise(resolve => { server.close(() => { evidence.stopped = true; persist(); resolve(); }); server.closeAllConnections(); }) };
}
