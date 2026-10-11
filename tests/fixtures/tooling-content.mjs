import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { uiRepairsFixture } from './ui-repairs-server.mjs';
import { localOrigin } from '../../scripts/lib/test-target-safety.mjs';
import { referralEmail } from './api-routes.mjs';

export async function createToolingContentFixture({ origin, artifact, apiRoutes = false }) {
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
  if (apiRoutes) {
    documents.push(document('referral', {
      name: 'Synthetic Creator',
      creatorEmail: referralEmail,
      registrationStatus: 'active',
      slug: { current: 'fixture-creator' },
    }, 'tooling-referral'));
  }
  const layoutImages = process.env.TOOLING_CLS_CONTENT === '1' ? [
    { id: 'image-cls-wide', width: 800, height: 400, storagePath: 'images/cls-wide.svg' },
    { id: 'image-cls-tall', width: 600, height: 900, storagePath: 'images/cls-tall.svg' },
  ].map(image => ({ ...image, body: `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}"><rect width="100%" height="100%" fill="#18202c"/><text x="24" y="48" fill="white" font-size="24">Synthetic review</text></svg>` })) : [];
  if (layoutImages.length) {
    documents.push(
      ...Array.from({ length: 4 }, (_, index) => document('tool', {
        title: `Fixture layout tool ${index + 1}`,
        shortDescription: 'Synthetic tool content for layout stability checks.',
        category: 'Benchmark',
        downloadMode: 'external',
        downloadUrl: '/favicon-96x96.png',
        sortOrder: index,
      }, `tooling-cls-tool-${index}`)),
      ...layoutImages.map(image => document('review', {
        alt: `Fixture layout review ${image.width} by ${image.height}`,
        image: { _type: 'image', asset: { _type: 'reference', _ref: image.id } },
      }, image.id.replace('image-', 'review-'))),
    );
  }
  const initialDocuments = structuredClone(documents);
  const dispatches = new Map();
  const rateLimits = new Map();
  let delivery = 'completed';
  let session = 'valid';
  let failure = '';
  let revision = 0;
  let enqueueDelayMs = 0;
  let emailDelayMs = 0;
  const emails = [];
  const mutate = mutations => {
    if (!Array.isArray(mutations) || !mutations.length) throw new Error('Missing fixture mutations.');
    const next = structuredClone(documents);
    const results = [];
    for (const mutation of mutations) {
      const value = mutation.document;
      if (!value?._id || !value?._type || !['create', 'replace'].includes(mutation.operation)) throw new Error('Unsupported fixture mutation.');
      const index = next.findIndex(row => row._id === value._id);
      if (mutation.operation === 'create' && index >= 0) throw Object.assign(new Error('Synthetic duplicate ID.'), { status: 409, code: '23505' });
      if (mutation.operation === 'replace' && (index < 0 || next[index]._rev !== mutation.expected_revision)) throw Object.assign(new Error('Synthetic revision conflict.'), { status: 409, code: '40001' });
      const saved = { ...value, _rev: `tooling-fixture-${++revision}` };
      if (index >= 0) next[index] = saved;
      else next.push(saved);
      results.push(saved);
    }
    documents.splice(0, documents.length, ...next);
    return results;
  };
  const evidence = { origin, pid: process.pid, contentSha256: createHash('sha256').update(JSON.stringify(documents)).digest('hex'), documentTypes: [...new Set(documents.map(row => row._type))], requests: [], stopped: false, standIn: `Synthetic ${apiRoutes ? 'in-memory' : 'read-only'} HTTP responses shaped as the current PostgREST RPC contract. Actual Supabase SDK and GROQ evaluator execute. No PostgreSQL, hosted PostgREST, Sanity, GoTrue, provider or persistence equivalence is claimed.` };
  const persist = () => { if (artifact) { fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, JSON.stringify(evidence, null, 2) + '\n'); } };
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 131072) throw new Error('Fixture body is too large.'); }
      const body = raw ? JSON.parse(raw) : {};
      const call = { method: req.method, path: url.pathname, body, status: 503, rows: 0, receivedAt: Date.now(), delayMs: 0 };
      res.once('finish', () => { call.respondedAt = Date.now(); persist(); });
      evidence.requests.push(call);
      if (apiRoutes && url.pathname === '/__fixture' && ['GET', 'POST'].includes(req.method)) {
        if (req.method === 'POST') {
          if (body.reset === true) {
            documents.splice(0, documents.length, ...structuredClone(initialDocuments));
            dispatches.clear();
            rateLimits.clear();
            evidence.requests.length = 0;
            delivery = 'completed';
            session = 'valid';
            failure = '';
            enqueueDelayMs = 0;
            emailDelayMs = 0;
            emails.length = 0;
          }
          if (body.delivery !== undefined) {
            if (!['completed', 'pending', 'queued', 'failed', 'dead_letter', 'source_conflict', 'token_conflict', 'enqueue_failed', 'lookup_failed', 'requeue_failed', 'captured'].includes(body.delivery)) throw new Error('Invalid fixture delivery state.');
            delivery = body.delivery;
          }
          if (body.session !== undefined) {
            if (!['valid', 'unavailable', 'network_error', 'malformed_response', 'inactive', 'deleted', 'revoked', 'no_role', 'principal_mismatch', 'code_mismatch', 'referral_mismatch'].includes(body.session)) throw new Error('Invalid fixture session state.');
            session = body.session;
          }
          if (body.failure !== undefined) {
            if (!['', 'limiter', 'settings', 'commerce_control', 'hold_write'].includes(body.failure)) throw new Error('Invalid fixture failure state.');
            failure = body.failure;
          }
          for (const name of ['enqueueDelayMs', 'emailDelayMs']) {
            if (body[name] !== undefined && (!Number.isInteger(body[name]) || body[name] < 0 || body[name] > 2000)) throw new Error('Invalid fixture delay.');
          }
          if (body.enqueueDelayMs !== undefined) enqueueDelayMs = body.enqueueDelayMs;
          if (body.emailDelayMs !== undefined) emailDelayMs = body.emailDelayMs;
          if (body.bookingDocuments !== undefined) {
            if (!Array.isArray(body.bookingDocuments) || body.bookingDocuments.some(row => !row?._id || !['booking', 'bookingSlot', 'slotHold'].includes(row._type))) throw new Error('Invalid fixture booking documents.');
            for (const row of body.bookingDocuments) {
              const index = documents.findIndex(value => value._id === row._id);
              const value = { ...row, _rev: `tooling-fixture-${++revision}` };
              if (index >= 0) documents[index] = value;
              else documents.push(value);
            }
          }
        }
        call.status = 200;
        json(res, 200, { delivery, session, documents, requests: evidence.requests, emails });
      } else if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_fetch_shadow_documents_targeted') {
        const scopedIds = apiRoutes && body.p_document_types === null && Array.isArray(body.p_ids) && body.p_ids.length > 0;
        if ((!scopedIds && (!Array.isArray(body.p_document_types) || !body.p_document_types.length)) || !Array.isArray(body.p_filters) || !Number.isInteger(body.p_limit) || body.p_limit < 1 || body.p_limit > 1000 || body.p_ids !== null && !Array.isArray(body.p_ids)) throw new Error('Invalid fixture read scope.');
        if (apiRoutes && delivery === 'lookup_failed' && body.p_document_types?.includes('referral')) throw Object.assign(new Error('Synthetic referral lookup outage.'), { status: 503, code: 'FIXTURE_LOOKUP_UNAVAILABLE' });
        if (apiRoutes && ((failure === 'settings' && body.p_document_types?.includes('bookingSettings')) || (failure === 'limiter' && body.p_document_types?.includes('rateLimitBucket')))) throw Object.assign(new Error('Synthetic document read outage.'), { status: 503, code: 'FIXTURE_READ_UNAVAILABLE' });
        if (body.p_document_types?.some(type => type === 'tool' || type === 'review')) {
          if (process.env.TOOLING_CLS_RESPONSE === 'delayed') {
            call.delayMs = 650;
            await new Promise(resolve => setTimeout(resolve, call.delayMs));
          }
          if (process.env.TOOLING_CLS_RESPONSE === 'failed') {
            call.status = 503;
            json(res, 503, { code: 'FIXTURE_CONTENT_UNAVAILABLE', message: 'Synthetic content is unavailable.' });
            persist();
            return;
          }
        }
        let rows = documents.filter(row => (!body.p_document_types || body.p_document_types.includes(row._type)) && (!body.p_ids || body.p_ids.includes(row._id)));
        for (const filter of body.p_filters) {
          if (!['eq', 'ieq', 'in'].includes(filter.op) || typeof filter.path !== 'string') throw new Error('Unsupported fixture filter.');
          rows = rows.filter(row => { const value = filter.path.split('.').reduce((item, key) => item?.[key], row); return filter.op === 'in' ? Array.isArray(filter.value) && filter.value.includes(value) : filter.op === 'ieq' ? String(value).toLowerCase() === String(filter.value).toLowerCase() : value === filter.value; });
        }
        rows = rows.sort((a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0).slice(0, body.p_limit); call.status = 200; call.rows = rows.length; json(res, 200, rows);
      } else if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_asset_manifest_for_refs') {
        const assets = layoutImages.filter(image => body.p_asset_ids?.includes(image.id)).map(image => ({
          legacy_sanity_asset_id: image.id,
          storage_bucket: 'site-content-public',
          storage_path: image.storagePath,
          migration_status: 'verified',
          sha256: createHash('sha256').update(image.body).digest('hex'),
          width: image.width,
          height: image.height,
        }));
        call.status = 200; json(res, 200, assets);
      } else if (req.method === 'GET' && layoutImages.some(image => url.pathname === `/storage/v1/object/public/site-content-public/${image.storagePath}`)) {
        const image = layoutImages.find(image => url.pathname.endsWith(image.storagePath));
        call.status = 200;
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        res.end(image.body);
      } else if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_fetch_commerce_availability') {
        call.status = 200; json(res, 200, { bookings: [], holds: [], slotLocks: [] });
      } else if (apiRoutes && req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_commerce_control') {
        if (failure === 'commerce_control') throw Object.assign(new Error('Synthetic commerce control outage.'), { status: 503, code: 'FIXTURE_CONTROL_UNAVAILABLE' });
        call.status = 200;
        json(res, 200, { primary_backend: 'supabase', generation: 0, starts_paused: false });
      } else if (apiRoutes && req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_consume_rate_limit') {
        if (failure === 'limiter') throw Object.assign(new Error('Synthetic rate limiter outage.'), { status: 503, code: 'FIXTURE_LIMITER_UNAVAILABLE' });
        const key = `${body.p_bucket_key_hmac}:${body.p_window_started_at}`;
        const count = rateLimits.get(key) || 0;
        rateLimits.set(key, count + 1);
        call.status = 200;
        json(res, 200, { allowed: count < body.p_max });
      } else if (apiRoutes && req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_apply_commerce_document_mutations') {
        if (failure === 'hold_write') throw Object.assign(new Error('Synthetic hold write outage.'), { status: 503, code: 'FIXTURE_WRITE_UNAVAILABLE' });
        const results = mutate(body.p_mutations);
        call.status = 200;
        json(res, 200, { results });
      } else if (apiRoutes && req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_record_commerce_metric') {
        call.status = 200;
        json(res, 200, {});
      } else if (apiRoutes && req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_validate_referral_session') {
        if (session === 'unavailable') throw Object.assign(new Error('Synthetic account verification outage.'), { status: 503, code: 'FIXTURE_ACCOUNT_UNAVAILABLE' });
        if (session === 'network_error') {
          call.status = 0;
          req.socket.destroy();
        } else if (session === 'malformed_response') {
          call.status = 200;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{invalid-json');
        } else {
          call.status = 200;
          const rejected = ['inactive', 'deleted', 'revoked'].includes(session) || body.p_creator_legacy_id !== 'tooling-referral' || body.p_session_version !== 1;
          json(res, 200, rejected ? null : {
            creator_legacy_sanity_id: session === 'referral_mismatch' ? 'different-referral' : 'tooling-referral',
            principal_id: session === 'principal_mismatch' ? 'different-principal' : 'fixture-principal',
            referral_code: session === 'code_mismatch' ? 'different-code' : 'fixture-creator',
            session_version: 1,
            roles: session === 'no_role' ? [] : ['creator'],
          });
        }
      } else if (apiRoutes && req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_apply_document_mutations') {
        const results = mutate(body.p_mutations);
        call.status = 200;
        json(res, 200, results);
      } else if (apiRoutes && req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_enqueue_referral_email_mutation') {
        if (enqueueDelayMs) await new Promise(resolve => setTimeout(resolve, enqueueDelayMs));
        if (delivery === 'token_conflict') throw Object.assign(new Error('Synthetic reset token revision conflict.'), { status: 409, code: '40001' });
        if (delivery === 'enqueue_failed') throw Object.assign(new Error('Synthetic email enqueue outage.'), { status: 503, code: 'FIXTURE_ENQUEUE_UNAVAILABLE' });
        mutate(body.p_mutations);
        const key = `referral-email-${createHash('sha256').update(`${body.p_dispatch_kind}:${body.p_referral_id}:${body.p_token_hash}:${body.p_recipient_hash}`).digest('hex')}`;
        dispatches.set(key, { idempotency_key: key, dispatch_kind: body.p_dispatch_kind, recipient_email: body.p_recipient_email, delivery_payload: body.p_delivery_payload });
        call.status = 200;
        json(res, 200, { idempotency_key: key });
      } else if (apiRoutes && req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_claim_referral_email_dispatch') {
        const dispatch = dispatches.get(body.p_idempotency_key);
        if (!dispatch) throw new Error('Unknown fixture dispatch.');
        call.status = 200;
        json(res, 200, ['failed', 'captured'].includes(delivery)
          ? { ...dispatch, claimed: true, attempt_count: 1 }
          : { claimed: false, sent: delivery === 'completed', in_progress: delivery === 'pending', dead_letter: ['dead_letter', 'requeue_failed', 'source_conflict'].includes(delivery), source_state_changed: delivery === 'source_conflict' });
      } else if (apiRoutes && req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_complete_referral_email_dispatch') {
        call.status = 200;
        json(res, 200, { status: body.p_success ? 'sent' : 'retry' });
      } else if (apiRoutes && req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_requeue_referral_email_dispatch') {
        if (delivery === 'requeue_failed') throw Object.assign(new Error('Synthetic email recovery outage.'), { status: 503, code: 'FIXTURE_REQUEUE_UNAVAILABLE' });
        call.status = 200;
        json(res, 200, { requeued: false, sent: false, recovery_blocked_reason: 'delivery_token_missing' });
      } else if (apiRoutes && req.method === 'POST' && url.pathname === '/rest/v1/rpc/roo_refresh_operational_shadow') {
        call.status = 200;
        json(res, 200, {});
      } else if (apiRoutes && req.method === 'POST' && url.pathname === '/emails') {
        const idempotencyKey = req.headers['idempotency-key'];
        if (req.headers.authorization !== 'Bearer fixture-only-referral-email-key' || !dispatches.has(idempotencyKey) ||
            !Array.isArray(body.to) || body.to.length !== 1 || body.to[0] !== referralEmail) throw new Error('Invalid fixture email request.');
        if (delivery === 'failed') throw Object.assign(new Error('Synthetic email provider unavailable.'), { status: 503, code: 'email_provider_unconfigured' });
        if (delivery !== 'captured') throw new Error('Fixture email delivery is not enabled.');
        if (emailDelayMs) await new Promise(resolve => setTimeout(resolve, emailDelayMs));
        const id = `fixture-email-${emails.length + 1}`;
        emails.push({ id, idempotencyKey, ...body, sentAt: Date.now() });
        call.status = 200;
        json(res, 200, { id });
      } else {
        json(res, 503, { code: 'FIXTURE_READ_ONLY', message: 'Synthetic content fixture refuses this operation.' });
      }
      persist();
    } catch (error) { json(res, error.status || 400, { code: error.code || 'FIXTURE_INPUT_INVALID', message: error.message }); persist(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(target.port), target.hostname, resolve); });
  persist();
  return { evidence, close: () => new Promise(resolve => { server.close(() => { evidence.stopped = true; persist(); resolve(); }); server.closeAllConnections(); }) };
}
