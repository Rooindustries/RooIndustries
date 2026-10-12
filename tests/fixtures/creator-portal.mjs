import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const userId = 'a0000000-0000-4000-8000-000000000001';
const token = 'a'.repeat(64);
const verification = 'b'.repeat(43);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const passwordHash = bcrypt.hashSync('Synthetic-password1!', 12);
let initial;
let authUsers = new Map();
let credentials = new Map();
let operations = new Map();
let versions = new Map();
let settings = {};
let registrationUser;

function account(referral, id = userId) {
  return {
    user_id: id, principal_id: 'fixture-principal', legacy_sanity_id: referral._id,
    creator_legacy_sanity_id: referral._id, primary_email: referral.creatorEmail,
    verified_real_email: referral.creatorEmail, referral_code: referral.slug.current,
    session_version: versions.get(id) || 1, credential_version: 2, roles: ['creator'], status: 'active',
    creator_active: referral.registrationStatus !== 'pending_email', credential_status: 'ready',
  };
}
function authUser(email = 'creator@fixture.invalid', id = userId) {
  return { id, email, aud: 'authenticated', role: 'authenticated', email_confirmed_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z', app_metadata: { roles: ['creator'] }, user_metadata: {}, identities: [{ provider: 'email', id, user_id: id }] };
}
function session(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: user.id, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, session_id: 'fixture-auth-session', email: user.email, amr: [{ method: 'password', timestamp: now }] };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', 'fixture-jwt-signing-secret').update(`${header}.${body}`).digest('base64url');
  return { access_token: `${header}.${body}.${signature}`, refresh_token: `fixture-refresh-${user.id}`, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, user };
}
function seed(documents) {
  const referral = documents.find(row => row._id === 'tooling-referral');
  Object.assign(referral, {
    creatorPassword: passwordHash, currentCommissionPercent: 7.25, currentDiscountPercent: 2.75,
    maxCommissionPercent: 15, successfulReferrals: 8, isFirstTime: false,
    paypalEmail: 'payout@fixture.invalid', contactDiscord: 'synthetic-creator',
    xocPayments: [{ _key: 'payment-xoc-1', amount: 10, paidOn: '2026-10-10', note: 'Date-only payout' }],
    vertexPayments: [{ _key: 'payment-vertex-1', amount: 5.25, paidOn: '2026-10-10T12:00:00Z', note: 'UTC timestamp payout' }],
    resetTokenHash: hash(token), resetTokenExpiresAt: '2099-01-01T00:00:00Z',
  });
  documents.push(
    { _id: 'portal-pending', _rev: 'portal-pending-1', _type: 'referral', name: 'Pending Creator', creatorEmail: 'pending@fixture.invalid', paypalEmail: 'pending-payout@fixture.invalid', slug: { current: 'pending-code' }, creatorPassword: passwordHash, registrationStatus: 'pending_email', registrationVerificationTokenHash: hash(verification), registrationVerificationExpiresAt: '2099-01-01T00:00:00Z' },
    { _id: 'portal-coupon', _type: 'coupon', code: 'coupon-code' },
    ...[
      ['max-captured', 'Performance Vertex Max', 'captured', 12.5],
      ['max-completed', 'Performance Vertex Max', 'completed', 1.25],
      ['vertex-captured', 'Performance Vertex Overhaul', 'captured', 7.75],
      ['vertex-pending', 'Performance Vertex Overhaul', 'pending', 100],
    ].map(([id, packageTitle, status, commissionAmount]) => ({ _id: `portal-${id}`, _type: 'booking', packageTitle, status, commissionAmount, referral: { _ref: referral._id }, referralCode: referral.slug.current })),
  );
  authUsers.set(userId, authUser());
  credentials.set(userId, passwordHash);
}

export async function portalHandle(ctx) {
  const { req, res, url, body, documents, call, json, mutate, evidence } = ctx;
  if (!initial) { seed(documents); initial = structuredClone(documents); }
  const send = (value, status = 200) => { call.status = status; json(res, status, value); return true; };
  if (url.pathname === '/__portal') {
    if (body.reset) {
      documents.splice(0, documents.length, ...structuredClone(initial));
      authUsers = new Map([[userId, authUser()]]);
      credentials = new Map([[userId, passwordHash]]);
      operations.clear();
      versions.clear();
      registrationUser = undefined;
      settings = {};
      evidence.requests.length = 0;
    }
    Object.assign(settings, body.settings || {});
    for (const value of body.documents || []) {
      const index = documents.findIndex(row => row._id === value._id);
      if (index < 0) documents.push(value); else Object.assign(documents[index], value);
    }
    return send({ settings, documents, operations: [...operations.values()], requests: evidence.requests, resetToken: token, verificationToken: verification });
  }
  if (url.pathname === '/rest/v1/rpc/roo_creator_registration_conflicts') {
    return send({ email_reserved: false, referral_code_reserved: documents.some(row => row._type === 'referral' && row.slug?.current === body.p_referral_code && row.registrationStatus === 'active') });
  }
  if (url.pathname === '/rest/v1/rpc/roo_fetch_shadow_documents_targeted' && settings.creatorReadUnavailable && (body.p_document_types?.includes('referral') || body.p_ids?.some(id => documents.some(row => row._id === id && row._type === 'referral')))) return send({ code: 'FIXTURE_READ_UNAVAILABLE', message: 'Synthetic creator read outage.' }, 503);
  if (url.pathname === '/rest/v1/rpc/roo_fetch_shadow_documents_targeted' && body.p_filters?.some(filter => ['gt', 'gte', 'lt', 'lte'].includes(filter.op))) {
    if (!body.p_document_types?.length || !Number.isInteger(body.p_limit) || body.p_limit < 1 || body.p_limit > 1000) throw new Error('Invalid creator fixture read scope.');
    let rows = documents.filter(row => body.p_document_types.includes(row._type) && (!body.p_ids || body.p_ids.includes(row._id)));
    for (const filter of body.p_filters) {
      rows = rows.filter(row => {
        const value = filter.path.split('.').reduce((item, key) => item?.[key], row);
        if (filter.op === 'eq') return value === filter.value;
        if (filter.op === 'ieq') return String(value).toLowerCase() === String(filter.value).toLowerCase();
        if (filter.op === 'in') return filter.value.includes(value);
        if (filter.op === 'gt') return value > filter.value;
        if (filter.op === 'gte') return value >= filter.value;
        if (filter.op === 'lt') return value < filter.value;
        if (filter.op === 'lte') return value <= filter.value;
        throw new Error('Unsupported creator fixture filter.');
      });
    }
    rows = rows.sort((a, b) => a._id.localeCompare(b._id)).slice(0, body.p_limit);
    call.rows = rows.length;
    return send(rows);
  }
  if (url.pathname === '/rest/v1/rpc/roo_referral_earnings_summary') {
    if (settings.earningsUnavailable) return send({ code: 'FIXTURE_READ_UNAVAILABLE', message: 'Synthetic earnings outage.' }, 503);
    return send(settings.emptyEarnings ? { xoc: 0, vertex: 0, total: 0, byPackage: {} } : { xoc: 13.75, vertex: 7.75, total: 21.5, byPackage: { 'Performance Vertex Max': 13.75, 'Performance Vertex Overhaul': 7.75 } });
  }
  if (url.pathname === '/rest/v1/rpc/roo_resolve_account_alias') {
    const referral = documents.find(row => row._type === 'referral' && row.registrationStatus === 'active' && [row.creatorEmail, row.slug?.current].includes(body.p_identifier));
    const user = [...authUsers.values()].find(row => row.email === referral?.creatorEmail);
    return send(referral && user ? account(referral, user.id) : null);
  }
  if (url.pathname === '/rest/v1/rpc/roo_account_by_user_id') {
    const user = authUsers.get(body.p_user_id);
    const referral = documents.find(row => row._type === 'referral' && row.creatorEmail === user?.email);
    return send(user && referral ? account(referral, user.id) : null);
  }
  if (url.pathname === '/rest/v1/rpc/roo_upsert_native_creator_account') {
    registrationUser = body.p_account.user_id;
    return send({ user_id: body.p_account.user_id });
  }
  if (url.pathname === '/rest/v1/rpc/roo_validate_referral_session' && (body.p_creator_legacy_id !== 'tooling-referral' || versions.has(userId))) {
    const referral = documents.find(row => row._id === body.p_creator_legacy_id && row.registrationStatus === 'active');
    const user = [...authUsers.values()].find(row => row.email === referral?.creatorEmail);
    const row = referral && user ? account(referral, user.id) : null;
    return send(row && row.session_version === body.p_session_version ? row : null);
  }
  if (url.pathname === '/rest/v1/rpc/roo_get_credential_operation_v2') return send(operations.get(body.p_operation_key) || null);
  if (url.pathname === '/rest/v1/rpc/roo_prepare_credential_operation_v2') {
    if (settings.credentialUnavailable) return send({ code: 'FIXTURE_CREDENTIAL_UNAVAILABLE', message: 'Synthetic credential outage.' }, 503);
    const previous = operations.get(body.p_operation_key);
    if (previous) return send({ code: '23505', message: 'Synthetic operation conflict.' }, 409);
    const source = documents.find(row => row._id === body.p_source_document_id);
    if (!source || source._rev !== body.p_source_expected_revision || Object.entries(body.p_source_preconditions).some(([key, value]) => source[key] !== value)) return send({ code: '40001', message: 'Synthetic credential precondition conflict.' }, 409);
    const operation = {
      operation_key: body.p_operation_key, user_id: body.p_user_id, principal_id: 'fixture-principal',
      password_hash: body.p_password_hash, source_backend: body.p_source_backend,
      source_document_id: body.p_source_document_id, source_expected_revision: body.p_source_expected_revision,
      source_preconditions: body.p_source_preconditions, source_mutation: body.p_source_mutation,
      status: 'prepared', source_recovery_blocked: false,
    };
    operations.set(operation.operation_key, operation);
    return send(operation);
  }
  if (url.pathname === '/rest/v1/rpc/roo_mark_credential_operation_v2') {
    const operation = operations.get(body.p_operation_key);
    if (!operation) return send({ code: 'P0002', message: 'Synthetic operation missing.' }, 404);
    operation.status = body.p_status;
    if (body.p_status === 'auth_applied' && !operation.sessions_revoked_at) {
      operation.sessions_revoked_at = new Date().toISOString();
      versions.set(operation.user_id, (versions.get(operation.user_id) || 1) + 1);
    }
    return send(operation);
  }
  if (url.pathname === '/rest/v1/rpc/roo_apply_credential_source_operation_v2') {
    const operation = operations.get(body.p_operation_key);
    if (!operation || !['auth_applied', 'mirrored'].includes(operation.status)) return send({ code: '55000', message: 'Synthetic operation not ready.' }, 409);
    const source = documents.find(row => row._id === operation.source_document_id);
    if (operation.status !== 'mirrored') {
      if (!source || source._rev !== operation.source_expected_revision || Object.entries(operation.source_preconditions).some(([key, value]) => source[key] !== value)) return send({ code: '40001', message: 'Synthetic source conflict.' }, 409);
      const updated = { ...source, ...operation.source_mutation.set };
      for (const field of operation.source_mutation.unset) delete updated[field];
      const [saved] = mutate([{ operation: 'replace', document: updated, expected_revision: source._rev }]);
      operation.source_applied_revision = saved._rev;
    }
    return send({ status: 'applied', source_document_id: operation.source_document_id });
  }
  if (url.pathname === '/rest/v1/rpc/roo_complete_credential_operation_v2') {
    const operation = operations.get(body.p_operation_key);
    if (!operation?.source_applied_revision) return send({ code: '55000', message: 'Synthetic source not applied.' }, 409);
    operation.status = 'mirrored';
    return send({ status: 'mirrored', session_version: versions.get(operation.user_id) || 1 });
  }
  if (url.pathname === '/rest/v1/rpc/roo_requeue_referral_email_dispatch') return send({ requeued: true, status: 'pending' });
  if (url.pathname === '/rest/v1/rpc/roo_reconcile_auth_identity_links') return send(null);
  if (url.pathname === '/auth/v1/token') {
    if (settings.authUnavailable) return send({ error_code: 'unexpected_failure', msg: 'Synthetic auth outage.' }, 503);
    const user = [...authUsers.values()].find(row => row.email === body.email) || authUsers.get(registrationUser) || authUsers.get(userId);
    if (url.searchParams.get('grant_type') === 'password' && (!user || !await bcrypt.compare(String(body.password || ''), credentials.get(user.id) || ''))) return send({ error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400);
    return send(session(user));
  }
  if (url.pathname === '/auth/v1/user') {
    if (settings.sessionInstallUnavailable) return send({ error_code: 'unexpected_failure', msg: 'Synthetic session install outage.' }, 503);
    const authorization = req.headers.authorization || '';
    let id = userId;
    try { id = JSON.parse(Buffer.from(authorization.split('.')[1], 'base64url')).sub; } catch {}
    return send(authUsers.get(id) || authUser());
  }
  if (url.pathname === '/auth/v1/logout') return send({});
  if (url.pathname === '/auth/v1/admin/users' && req.method === 'POST') {
    const user = authUser(body.email, body.id);
    user.app_metadata = body.app_metadata || {};
    authUsers.set(user.id, user);
    credentials.set(user.id, body.password_hash || bcrypt.hashSync(String(body.password || ''), 12));
    return send({ user });
  }
  if (url.pathname === '/auth/v1/admin/users' && req.method === 'GET') return send({ users: [...authUsers.values()], aud: 'authenticated', next_page: null });
  if (url.pathname.startsWith('/auth/v1/admin/users/')) {
    const id = url.pathname.split('/').at(-1);
    if (req.method === 'DELETE') { authUsers.delete(id); credentials.delete(id); return send({}); }
    const user = authUsers.get(id);
    if (!user) return send({ error_code: 'user_not_found', msg: 'User not found' }, 404);
    if (req.method === 'PUT') {
      const { password, password_hash: ignored, ...attributes } = body;
      Object.assign(user, attributes);
      if (password) credentials.set(id, bcrypt.hashSync(password, 12));
    }
    return send({ user });
  }
  if (url.pathname === '/auth/v1/admin/generate_link') {
    if (settings.linkUnavailable) return send({ error_code: 'unexpected_failure', msg: 'Synthetic verification outage.' }, 503);
    const user = [...authUsers.values()].find(row => row.email === body.email);
    return send({ action_link: `${url.origin}/auth/v1/verify?token=fixture-link&type=magiclink`, email_otp: '123456', hashed_token: 'fixture-link', redirect_to: process.env.BASE_URL, verification_type: 'magiclink', ...user });
  }
  if (url.pathname === '/auth/v1/verify') {
    const user = authUsers.get(registrationUser) || authUsers.get(userId);
    return send(session(user));
  }
  return false;
}
