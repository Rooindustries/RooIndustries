import assert from "node:assert/strict";
import crypto from "node:crypto";
import { provisionContentAdmin } from "../provision-content-admin.mjs";

export const CONTENT_ADMIN_EMAIL = "content-admin@example.invalid";
export const CONTENT_ADMIN_PASSWORD = "Synthetic-Content-Password-123";

export const seedContentAdmin = async fixture => {
  const users = new Map(), sessions = new Map(), requests = [];
  let loginReply, logoutReply;
  const digest = value => crypto.createHash("sha256").update(value).digest();
  const userShape = row => ({ id: row.id, email: row.email, aud: "authenticated", role: "authenticated", email_confirmed_at: row.email_confirmed_at, created_at: row.created_at, app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {}, identities: [] });
  fixture.setAuthHandler(async request => {
    requests.push({ method: request.method, path: request.path });
    const pathname = request.path.split("?")[0];
    if (pathname === "/auth/v1/admin/users" && request.method === "GET") {
      const params = new URL(request.path, fixture.origin).searchParams, page = Number(params.get("page") || 1), perPage = Number(params.get("per_page") || 50);
      return { body: { users: [...users.values()].slice((page - 1) * perPage, page * perPage).map(userShape), aud: "authenticated", next_page: null, last_page: 1, total: users.size } };
    }
    if (pathname === "/auth/v1/admin/users" && request.method === "POST") {
      const id = crypto.randomUUID(), email = request.body.email;
      const [row] = await fixture.sql`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data) values(${id},${email},now(),'{}'::jsonb) returning id,email,email_confirmed_at,created_at`;
      await fixture.sql`insert into auth.identities(user_id,provider,provider_id,email,identity_data) values(${id},'email',${id},${email},${JSON.stringify({sub:id,email,email_verified:true})}::jsonb)`;
      users.set(id, { ...row, passwordDigest: digest(request.body.password) });
      return { body: userShape(row) };
    }
    if (pathname.startsWith("/auth/v1/admin/users/") && request.method === "PUT") {
      const row = users.get(pathname.split("/").at(-1));
      assert.ok(row); row.passwordDigest = digest(request.body.password);
      return { body: userShape(row) };
    }
    if (pathname === "/auth/v1/token" && new URL(request.path, fixture.origin).searchParams.get("grant_type") === "password") {
      if (loginReply) return loginReply;
      const row = [...users.values()].find(user => user.email === request.body.email);
      if (!row || typeof request.body.password !== "string" || !crypto.timingSafeEqual(row.passwordDigest, digest(request.body.password))) return { status: 400, body: { error_code: "invalid_credentials", msg: "Invalid login credentials" } };
      const iat = Math.floor(Date.now() / 1000), header = Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url"), payload = Buffer.from(JSON.stringify({sub:row.id,role:"authenticated",aud:"authenticated",iat,exp:iat+3600})).toString("base64url");
      const accessToken = `${header}.${payload}.${crypto.createHmac("sha256", "synthetic-auth-secret").update(`${header}.${payload}`).digest("base64url")}`;
      sessions.set(accessToken, row);
      return { body: { access_token: accessToken, refresh_token: crypto.randomUUID(), expires_in: 3600, expires_at: iat + 3600, token_type: "bearer", user: userShape(row) } };
    }
    if (pathname === "/auth/v1/user") return { body: userShape([...users.values()][0]) };
    if (pathname === "/auth/v1/logout") { if (logoutReply) return logoutReply; sessions.clear(); return { body: {} }; }
    return { status: 404, body: { msg: "Unexpected fixture Auth route" } };
  });
  const account = await provisionContentAdmin({ email: CONTENT_ADMIN_EMAIL, password: CONTENT_ADMIN_PASSWORD, adminClient: fixture.client });
  const again = await provisionContentAdmin({ email: CONTENT_ADMIN_EMAIL, password: CONTENT_ADMIN_PASSWORD, adminClient: fixture.client });
  assert.deepEqual(again, account, "Provisioning is idempotent");
  const adminUser = [...users.values()].find(row => row.email === CONTENT_ADMIN_EMAIL);
  return { ...account, userId: adminUser.id, requests, sessions, users, setLoginReply(value) { loginReply = value; }, setLogoutReply(value) { logoutReply = value; } };
};
