import crypto from "crypto";
import { BracketsManager } from "brackets-manager";

const TOURNEY_ID = 0;
const TOURNEY_META_ID = "legacy-series-2026";
const ENGINE_TABLES = Object.freeze([
  "participant",
  "stage",
  "group",
  "round",
  "match",
  "match_game",
]);
const MATCH_STATUSES = Object.freeze({
  0: "Locked",
  1: "Waiting",
  2: "Ready",
  3: "Running",
  4: "Completed",
  5: "Archived",
  6: "Game Cancelled",
});
const PREVIEW_FIXTURE_KEY = "8x6";
const PREVIEW_FIXTURE_TEAM_NAMES = Object.freeze([
  "Roo Alpha",
  "Roo Bravo",
  "Roo Catalyst",
  "Roo Delta",
  "Roo Eclipse",
  "Roo Flux",
  "Roo Helix",
  "Roo Ion",
]);

const MEMORY_STORE =
  globalThis.__rooTourneyBracketStore ||
  (globalThis.__rooTourneyBracketStore = {
    teams: [],
    audit: [],
    entities: Object.fromEntries(ENGINE_TABLES.map((table) => [table, []])),
    counters: Object.fromEntries(ENGINE_TABLES.map((table) => [table, 0])),
    meta: {
      id: TOURNEY_META_ID,
      stageId: null,
      status: "draft",
      published: false,
      generatedAt: "",
      updatedAt: "",
      updatedBy: "",
    },
    lock: false,
    fixtureKey: "",
  });

const SQL_CLIENTS =
  globalThis.__rooTourneyBracketSqlClients ||
  (globalThis.__rooTourneyBracketSqlClients = new Map());
let schemaReady = false;

const nowIso = () => new Date().toISOString();

const normalizeText = (value) => String(value || "").trim();
const normalizeKey = (value) => normalizeText(value).toLowerCase();

const isPreviewFixtureMode = (env = process.env) =>
  normalizeKey(env.TOURNEY_BRACKET_PREVIEW_FIXTURE) === PREVIEW_FIXTURE_KEY &&
  env.VERCEL_ENV !== "production";

const isMemoryMode = (env = process.env) =>
  isPreviewFixtureMode(env) ||
  env.TOURNEY_BRACKET_STORE_MODE === "memory" ||
  env.TOURNEY_DATABASE_MODE === "memory";

const getDatabaseUrl = (env = process.env) =>
  normalizeText(env.TOURNEY_DATABASE_URL || env.POSTGRES_URL);

const getSql = async (env = process.env) => {
  const databaseUrl = getDatabaseUrl(env);
  if (!databaseUrl) {
    throw new Error("TOURNEY_DATABASE_URL is not configured.");
  }

  if (!SQL_CLIENTS.has(databaseUrl)) {
    const { neon } = await import("@neondatabase/serverless");
    SQL_CLIENTS.set(databaseUrl, neon(databaseUrl));
  }

  return SQL_CLIENTS.get(databaseUrl);
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const matchesFilter = (row, filter = {}) =>
  Object.entries(filter).every(([key, value]) => row?.[key] === value);

const sanitizeTeamName = (value) => {
  const name = normalizeText(value).replace(/\s+/g, " ");
  if (name.length < 2) {
    throw Object.assign(new Error("Team name must be at least 2 characters."), {
      status: 400,
    });
  }
  if (name.length > 48) {
    throw Object.assign(new Error("Team name must be 48 characters or fewer."), {
      status: 400,
    });
  }
  return name;
};

const normalizeSeed = (value) => {
  if (value === "" || value === null || value === undefined) return null;
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 1 || seed > 128) {
    throw Object.assign(new Error("Seed must be a whole number from 1 to 128."), {
      status: 400,
    });
  }
  return seed;
};

const nextPowerOfTwo = (value) => {
  let size = 1;
  while (size < value) size *= 2;
  return size;
};

const createDefaultMeta = () => ({
  id: TOURNEY_META_ID,
  stageId: null,
  status: "draft",
  published: false,
  generatedAt: "",
  updatedAt: "",
  updatedBy: "",
});

const isSchemaRaceError = (error) => {
  const message = [
    error?.code,
    error?.constraint,
    error?.message,
    error?.detail,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    /pg_type_typname_nsp_index/i.test(message) ||
    (["42P07", "42710"].includes(error?.code) &&
      /already exists|duplicate/i.test(message))
  );
};

const runSchemaStatement = async (statement) => {
  try {
    await statement();
  } catch (error) {
    if (!isSchemaRaceError(error)) {
      throw error;
    }
  }
};

const mapTeamRow = (row = {}) => ({
  id: row.id,
  name: row.name,
  seed: row.seed_order ?? row.seed ?? null,
  status: row.status || "active",
  memberCount: row.member_count ?? row.memberCount ?? 0,
  createdAt: row.created_at || row.createdAt || "",
  updatedAt: row.updated_at || row.updatedAt || "",
  updatedBy: row.updated_by || row.updatedBy || "",
});

const mapMetaRow = (row = {}) => ({
  id: row.id || TOURNEY_META_ID,
  stageId: row.stage_id ?? row.stageId ?? null,
  status: row.status || "draft",
  published: Boolean(row.published),
  generatedAt: row.generated_at || row.generatedAt || "",
  updatedAt: row.updated_at || row.updatedAt || "",
  updatedBy: row.updated_by || row.updatedBy || "",
});

const mapAuditRow = (row = {}) => ({
  id: row.id,
  action: row.action,
  actorUsername: row.actor_username || row.actorUsername || "",
  matchId: row.match_id ?? row.matchId ?? null,
  teamId: row.team_id || row.teamId || "",
  reason: row.reason || "",
  payload: typeof row.payload === "string" ? JSON.parse(row.payload || "{}") : row.payload || {},
  createdAt: row.created_at || row.createdAt || "",
});

export const resetMemoryTourneyBracketStoreForTests = () => {
  MEMORY_STORE.teams = [];
  MEMORY_STORE.audit = [];
  MEMORY_STORE.entities = Object.fromEntries(ENGINE_TABLES.map((table) => [table, []]));
  MEMORY_STORE.counters = Object.fromEntries(ENGINE_TABLES.map((table) => [table, 0]));
  MEMORY_STORE.meta = createDefaultMeta();
  MEMORY_STORE.lock = false;
  MEMORY_STORE.fixtureKey = "";
};

export async function ensureTourneyBracketSchema(env = process.env) {
  if (isMemoryMode(env) || schemaReady) return;

  const sql = await getSql(env);
  await runSchemaStatement(() => sql`
    create table if not exists tourney_bracket_teams (
      id text primary key,
      name text not null unique,
      seed_order integer,
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      updated_by text,
      constraint tourney_bracket_teams_status_check
        check (status in ('active', 'disqualified'))
    )
  `);
  await runSchemaStatement(() => sql`
    create table if not exists tourney_bracket_team_members (
      id text primary key,
      team_id text not null references tourney_bracket_teams(id) on delete cascade,
      player_id text,
      display_name text not null,
      role_play text,
      created_at timestamptz not null default now()
    )
  `);
  await runSchemaStatement(() => sql`
    create table if not exists tourney_bracket_meta (
      id text primary key,
      stage_id integer,
      status text not null default 'draft',
      published boolean not null default false,
      generated_at timestamptz,
      updated_at timestamptz not null default now(),
      updated_by text
    )
  `);
  await runSchemaStatement(() => sql`
    create table if not exists tourney_bracket_entities (
      entity_type text not null,
      entity_id integer not null,
      data jsonb not null,
      updated_at timestamptz not null default now(),
      primary key (entity_type, entity_id)
    )
  `);
  await runSchemaStatement(() => sql`
    create table if not exists tourney_bracket_counters (
      entity_type text primary key,
      next_id integer not null default 0
    )
  `);
  await runSchemaStatement(() => sql`
    create table if not exists tourney_bracket_audit (
      id text primary key,
      action text not null,
      actor_username text not null,
      match_id integer,
      team_id text,
      reason text,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )
  `);
  await runSchemaStatement(() => sql`
    create table if not exists tourney_bracket_lock (
      id text primary key,
      locked_until timestamptz not null,
      locked_by text
    )
  `);
  await sql`
    insert into tourney_bracket_meta (id, status, published)
    values (${TOURNEY_META_ID}, 'draft', false)
    on conflict (id) do nothing
  `;
  schemaReady = true;
}

class MemoryBracketStorage {
  async insert(table, values) {
    if (Array.isArray(values)) {
      for (const value of values) {
        await this.insert(table, value);
      }
      return true;
    }

    const id =
      values.id === undefined || values.id === null
        ? MEMORY_STORE.counters[table]
        : values.id;
    MEMORY_STORE.counters[table] = Math.max(
      MEMORY_STORE.counters[table],
      Number(id) + 1
    );
    MEMORY_STORE.entities[table].push({ ...clone(values), id });
    return id;
  }

  async select(table, arg) {
    const rows = MEMORY_STORE.entities[table] || [];
    if (arg === undefined) return clone(rows);
    if (typeof arg === "object" && arg !== null) {
      return clone(rows.filter((row) => matchesFilter(row, arg)));
    }
    return clone(rows.find((row) => row.id === arg) || null);
  }

  async update(table, arg, value) {
    const rows = MEMORY_STORE.entities[table] || [];
    const targets =
      typeof arg === "object" && arg !== null
        ? rows.filter((row) => matchesFilter(row, arg))
        : rows.filter((row) => row.id === arg);
    for (const row of targets) {
      Object.assign(row, clone(value));
    }
    return true;
  }

  async delete(table, filter) {
    if (filter === undefined) {
      MEMORY_STORE.entities[table] = [];
      MEMORY_STORE.counters[table] = 0;
      return true;
    }
    MEMORY_STORE.entities[table] = (MEMORY_STORE.entities[table] || []).filter(
      (row) => !matchesFilter(row, filter)
    );
    return true;
  }
}

class SqlBracketStorage {
  constructor(env = process.env) {
    this.env = env;
  }

  async sql() {
    await ensureTourneyBracketSchema(this.env);
    return getSql(this.env);
  }

  async nextId(table) {
    const sql = await this.sql();
    const rows = await sql`
      insert into tourney_bracket_counters (entity_type, next_id)
      values (${table}, 1)
      on conflict (entity_type) do update
        set next_id = tourney_bracket_counters.next_id + 1
      returning next_id - 1 as id
    `;
    return Number(rows?.[0]?.id || 0);
  }

  async insert(table, values) {
    if (Array.isArray(values)) {
      for (const value of values) {
        await this.insert(table, value);
      }
      return true;
    }

    const sql = await this.sql();
    const id =
      values.id === undefined || values.id === null ? await this.nextId(table) : values.id;
    const row = { ...clone(values), id };
    await sql`
      insert into tourney_bracket_entities (entity_type, entity_id, data, updated_at)
      values (${table}, ${Number(id)}, ${JSON.stringify(row)}::jsonb, now())
      on conflict (entity_type, entity_id) do update
        set data = excluded.data,
            updated_at = now()
    `;
    return id;
  }

  async select(table, arg) {
    const sql = await this.sql();
    if (arg === undefined) {
      const rows = await sql`
        select data
        from tourney_bracket_entities
        where entity_type = ${table}
        order by entity_id asc
      `;
      return rows.map((row) => clone(row.data));
    }
    if (typeof arg !== "object" || arg === null) {
      const rows = await sql`
        select data
        from tourney_bracket_entities
        where entity_type = ${table}
          and entity_id = ${Number(arg)}
        limit 1
      `;
      return rows?.[0] ? clone(rows[0].data) : null;
    }

    const rows = await this.select(table);
    return rows.filter((row) => matchesFilter(row, arg));
  }

  async update(table, arg, value) {
    const sql = await this.sql();
    const targets =
      typeof arg === "object" && arg !== null
        ? await this.select(table, arg)
        : [await this.select(table, arg)].filter(Boolean);
    for (const row of targets) {
      const nextRow = { ...row, ...clone(value) };
      await sql`
        update tourney_bracket_entities
        set data = ${JSON.stringify(nextRow)}::jsonb,
            updated_at = now()
        where entity_type = ${table}
          and entity_id = ${Number(nextRow.id)}
      `;
    }
    return true;
  }

  async delete(table, filter) {
    const sql = await this.sql();
    if (filter === undefined) {
      await sql`
        delete from tourney_bracket_entities
        where entity_type = ${table}
      `;
      await sql`
        insert into tourney_bracket_counters (entity_type, next_id)
        values (${table}, 0)
        on conflict (entity_type) do update set next_id = 0
      `;
      return true;
    }

    const targets = await this.select(table, filter);
    for (const row of targets) {
      await sql`
        delete from tourney_bracket_entities
        where entity_type = ${table}
          and entity_id = ${Number(row.id)}
      `;
    }
    return true;
  }
}

const createStorage = (env = process.env) =>
  isMemoryMode(env) ? new MemoryBracketStorage() : new SqlBracketStorage(env);

const createManager = (env = process.env) => new BracketsManager(createStorage(env));

const ensurePreviewFixtureLoaded = async (env = process.env) => {
  if (!isPreviewFixtureMode(env) || MEMORY_STORE.fixtureKey === PREVIEW_FIXTURE_KEY) {
    return;
  }

  resetMemoryTourneyBracketStoreForTests();
  const timestamp = nowIso();
  MEMORY_STORE.teams = PREVIEW_FIXTURE_TEAM_NAMES.map((name, index) => ({
    id: `preview-team-${index + 1}`,
    name,
    seed: index + 1,
    status: "active",
    memberCount: 6,
    createdAt: timestamp,
    updatedAt: timestamp,
    updatedBy: "preview-fixture",
  }));

  await createManager(env).create.stage({
    tournamentId: TOURNEY_ID,
    name: "6v6 Legacy Series",
    type: "double_elimination",
    seeding: PREVIEW_FIXTURE_TEAM_NAMES,
    settings: {
      grandFinal: "simple",
    },
  });

  const stages = await createStorage(env).select("stage");
  const stage = stages?.[0] || null;
  MEMORY_STORE.meta = {
    ...createDefaultMeta(),
    stageId: stage?.id ?? null,
    status: "generated",
    published: true,
    generatedAt: timestamp,
    updatedAt: timestamp,
    updatedBy: "preview-fixture",
  };
  MEMORY_STORE.audit.unshift({
    id: crypto.randomUUID(),
    action: "bracket.preview-fixture",
    actorUsername: "preview-fixture",
    matchId: null,
    teamId: "",
    reason: "8 teams, 6 players each",
    payload: { teamCount: 8, playersPerTeam: 6 },
    createdAt: timestamp,
  });
  MEMORY_STORE.fixtureKey = PREVIEW_FIXTURE_KEY;
};

const withBracketMutation = async ({ actorUsername, env, callback }) => {
  await ensurePreviewFixtureLoaded(env);

  if (isMemoryMode(env)) {
    if (MEMORY_STORE.lock) {
      throw Object.assign(new Error("Bracket is busy. Try again."), { status: 409 });
    }
    MEMORY_STORE.lock = true;
    try {
      return await callback();
    } finally {
      MEMORY_STORE.lock = false;
    }
  }

  await ensureTourneyBracketSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    insert into tourney_bracket_lock (id, locked_until, locked_by)
    values ('default', now() + interval '45 seconds', ${actorUsername})
    on conflict (id) do update
      set locked_until = excluded.locked_until,
          locked_by = excluded.locked_by
      where tourney_bracket_lock.locked_until < now()
    returning id
  `;
  if (!rows?.[0]) {
    throw Object.assign(new Error("Bracket is busy. Try again."), { status: 409 });
  }

  try {
    return await callback();
  } finally {
    await sql`
      update tourney_bracket_lock
      set locked_until = now(),
          locked_by = null
      where id = 'default'
    `;
  }
};

const readMeta = async (env = process.env) => {
  if (isMemoryMode(env)) return { ...MEMORY_STORE.meta };
  await ensureTourneyBracketSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    select *
    from tourney_bracket_meta
    where id = ${TOURNEY_META_ID}
    limit 1
  `;
  return mapMetaRow(rows?.[0] || createDefaultMeta());
};

const writeMeta = async ({ meta, env = process.env }) => {
  if (isMemoryMode(env)) {
    MEMORY_STORE.meta = { ...MEMORY_STORE.meta, ...meta };
    return { ...MEMORY_STORE.meta };
  }

  await ensureTourneyBracketSchema(env);
  const sql = await getSql(env);
  const next = { ...createDefaultMeta(), ...meta };
  await sql`
    insert into tourney_bracket_meta (
      id, stage_id, status, published, generated_at, updated_at, updated_by
    )
    values (
      ${TOURNEY_META_ID}, ${next.stageId}, ${next.status}, ${next.published},
      ${next.generatedAt || null}, ${next.updatedAt || nowIso()}, ${next.updatedBy || ""}
    )
    on conflict (id) do update set
      stage_id = excluded.stage_id,
      status = excluded.status,
      published = excluded.published,
      generated_at = excluded.generated_at,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `;
  return readMeta(env);
};

const recordAudit = async ({
  action,
  actorUsername,
  matchId = null,
  teamId = "",
  reason = "",
  payload = {},
  env = process.env,
}) => {
  const audit = {
    id: crypto.randomUUID(),
    action,
    actorUsername: normalizeKey(actorUsername),
    matchId,
    teamId,
    reason: normalizeText(reason),
    payload,
    createdAt: nowIso(),
  };

  if (isMemoryMode(env)) {
    MEMORY_STORE.audit.unshift(audit);
    MEMORY_STORE.audit = MEMORY_STORE.audit.slice(0, 80);
    return audit;
  }

  await ensureTourneyBracketSchema(env);
  const sql = await getSql(env);
  await sql`
    insert into tourney_bracket_audit (
      id, action, actor_username, match_id, team_id, reason, payload, created_at
    )
    values (
      ${audit.id}, ${audit.action}, ${audit.actorUsername}, ${audit.matchId},
      ${audit.teamId || null}, ${audit.reason}, ${JSON.stringify(payload)}::jsonb,
      ${audit.createdAt}
    )
  `;
  return audit;
};

export const listTourneyBracketTeams = async ({
  includeDisqualified = false,
  env = process.env,
} = {}) => {
  if (isMemoryMode(env)) {
    return MEMORY_STORE.teams
      .filter((team) => includeDisqualified || team.status === "active")
      .map(mapTeamRow)
      .sort(compareTeams);
  }

  await ensureTourneyBracketSchema(env);
  const sql = await getSql(env);
  const rows = includeDisqualified
    ? await sql`select * from tourney_bracket_teams`
    : await sql`select * from tourney_bracket_teams where status = 'active'`;
  return rows.map(mapTeamRow).sort(compareTeams);
};

const compareTeams = (left, right) => {
  const leftSeed = left.seed ?? Number.MAX_SAFE_INTEGER;
  const rightSeed = right.seed ?? Number.MAX_SAFE_INTEGER;
  if (leftSeed !== rightSeed) return leftSeed - rightSeed;
  return left.name.localeCompare(right.name);
};

const upsertTeamUnlocked = async ({
  teamId,
  name,
  seed,
  actorUsername,
  env = process.env,
}) => {
  const teamName = sanitizeTeamName(name);
  const seedOrder = normalizeSeed(seed);
  const now = nowIso();
  const id = normalizeText(teamId) || crypto.randomUUID();
  const existing = await listTourneyBracketTeams({
    includeDisqualified: true,
    env,
  });
  const duplicate = existing.find(
    (team) => team.id !== id && normalizeKey(team.name) === normalizeKey(teamName)
  );
  if (duplicate) {
    throw Object.assign(new Error("Team name is already used."), { status: 409 });
  }

  const previous = existing.find((team) => team.id === id);
  const team = {
    id,
    name: teamName,
    seed: seedOrder,
    status: "active",
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    updatedBy: normalizeKey(actorUsername),
  };

  if (isMemoryMode(env)) {
    const index = MEMORY_STORE.teams.findIndex((row) => row.id === id);
    if (index >= 0) {
      MEMORY_STORE.teams[index] = team;
    } else {
      MEMORY_STORE.teams.push(team);
    }
  } else {
    await ensureTourneyBracketSchema(env);
    const sql = await getSql(env);
    await sql`
      insert into tourney_bracket_teams (
        id, name, seed_order, status, created_at, updated_at, updated_by
      )
      values (
        ${team.id}, ${team.name}, ${team.seed}, ${team.status},
        ${team.createdAt}, ${team.updatedAt}, ${team.updatedBy}
      )
      on conflict (id) do update set
        name = excluded.name,
        seed_order = excluded.seed_order,
        status = 'active',
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `;
  }

  return team;
};

export const upsertTourneyBracketTeam = async ({
  teamId,
  name,
  seed,
  actorUsername,
  env = process.env,
} = {}) =>
  withBracketMutation({
    actorUsername,
    env,
    callback: async () => {
      const team = await upsertTeamUnlocked({
        teamId,
        name,
        seed,
        actorUsername,
        env,
      });
      await recordAudit({
        action: teamId ? "team.update" : "team.create",
        actorUsername,
        teamId: team.id,
        payload: { name: team.name, seed: team.seed },
        env,
      });
      return team;
    },
  });

export const deleteTourneyBracketTeam = async ({
  teamId,
  actorUsername,
  env = process.env,
} = {}) =>
  withBracketMutation({
    actorUsername,
    env,
    callback: async () => {
      const meta = await readMeta(env);
      if (meta.stageId !== null) {
        throw Object.assign(new Error("Reset the bracket before deleting teams."), {
          status: 400,
        });
      }
      if (isMemoryMode(env)) {
        MEMORY_STORE.teams = MEMORY_STORE.teams.filter((team) => team.id !== teamId);
      } else {
        await ensureTourneyBracketSchema(env);
        const sql = await getSql(env);
        await sql`delete from tourney_bracket_teams where id = ${teamId}`;
      }
      await recordAudit({
        action: "team.delete",
        actorUsername,
        teamId,
        env,
      });
      return true;
    },
  });

export const seedTourneyBracketTeams = async ({
  teamIds = [],
  actorUsername,
  env = process.env,
} = {}) =>
  withBracketMutation({
    actorUsername,
    env,
    callback: async () => {
      const ids = teamIds.map(normalizeText).filter(Boolean);
      if (ids.length < 2 || new Set(ids).size !== ids.length) {
        throw Object.assign(new Error("Choose at least two unique teams."), {
          status: 400,
        });
      }
      const teams = await listTourneyBracketTeams({ includeDisqualified: false, env });
      const activeIds = new Set(teams.map((team) => team.id));
      if (ids.some((id) => !activeIds.has(id))) {
        throw Object.assign(new Error("Seed list includes an unavailable team."), {
          status: 400,
        });
      }

      for (let index = 0; index < ids.length; index += 1) {
        await upsertTeamUnlocked({
          teamId: ids[index],
          name: teams.find((team) => team.id === ids[index])?.name,
          seed: index + 1,
          actorUsername,
          env,
        });
      }
      await recordAudit({
        action: "team.seed",
        actorUsername,
        payload: { teamIds: ids },
        env,
      });
      return listTourneyBracketTeams({ includeDisqualified: true, env });
    },
  });

const clearEngineData = async (env = process.env) => {
  const storage = createStorage(env);
  for (const table of ENGINE_TABLES) {
    await storage.delete(table);
  }
};

export const generateTourneyBracket = async ({
  actorUsername,
  env = process.env,
} = {}) =>
  withBracketMutation({
    actorUsername,
    env,
    callback: async () => {
      const teams = await listTourneyBracketTeams({ includeDisqualified: false, env });
      if (teams.length < 2) {
        throw Object.assign(new Error("Create at least two active teams first."), {
          status: 400,
        });
      }

      await clearEngineData(env);
      const manager = createManager(env);
      const seeding = teams.map((team) => team.name);
      while (seeding.length < nextPowerOfTwo(teams.length)) {
        seeding.push(null);
      }
      await manager.create.stage({
        tournamentId: TOURNEY_ID,
        name: "6v6 Legacy Series",
        type: "double_elimination",
        seeding,
        settings: {
          grandFinal: "simple",
        },
      });

      const stages = await createStorage(env).select("stage");
      const stage = stages?.[0] || null;
      await writeMeta({
        env,
        meta: {
          stageId: stage?.id ?? null,
          status: "generated",
          published: true,
          generatedAt: nowIso(),
          updatedAt: nowIso(),
          updatedBy: normalizeKey(actorUsername),
        },
      });
      await recordAudit({
        action: "bracket.generate",
        actorUsername,
        payload: { teamCount: teams.length, stageId: stage?.id ?? null },
        env,
      });
      return getTourneyBracketSnapshot({ includeAudit: true, env });
    },
  });

const readEngineData = async (env = process.env) => {
  const storage = createStorage(env);
  const data = {};
  for (const table of ENGINE_TABLES) {
    data[table] = (await storage.select(table)) || [];
  }
  return data;
};

const getGroupName = (group) => {
  if (group?.number === 1) return "Winners";
  if (group?.number === 2) return "Losers";
  if (group?.number === 3) return "Grand Final";
  return "Bracket";
};

const getMatchBestOf = (match, group) => (group?.number === 3 ? 7 : 5);

const getMatchTargetScore = (match, group) =>
  Math.ceil(getMatchBestOf(match, group) / 2);

const getSide = (match, side) => {
  if (side !== "opponent1" && side !== "opponent2") {
    throw Object.assign(new Error("Choose a valid match side."), { status: 400 });
  }
  const opponent = match?.[side];
  if (!opponent?.id && opponent?.id !== 0) {
    throw Object.assign(new Error("That match side is still TBD."), { status: 400 });
  }
  return opponent;
};

const findMatch = async ({ matchId, env }) => {
  const match = await createStorage(env).select("match", Number(matchId));
  if (!match) {
    throw Object.assign(new Error("Match not found."), { status: 404 });
  }
  return match;
};

const validateScoreResult = ({ match, group, opponent1Score, opponent2Score }) => {
  const leftScore = Number(opponent1Score);
  const rightScore = Number(opponent2Score);
  const target = getMatchTargetScore(match, group);
  const bestOf = getMatchBestOf(match, group);
  if (
    !Number.isInteger(leftScore) ||
    !Number.isInteger(rightScore) ||
    leftScore < 0 ||
    rightScore < 0 ||
    leftScore > target ||
    rightScore > target ||
    leftScore === rightScore ||
    Math.max(leftScore, rightScore) !== target ||
    Math.min(leftScore, rightScore) >= target
  ) {
    throw Object.assign(
      new Error(`Enter a valid Best of ${bestOf} result.`),
      { status: 400 }
    );
  }
  return {
    opponent1Score: leftScore,
    opponent2Score: rightScore,
    winnerSide: leftScore > rightScore ? "opponent1" : "opponent2",
  };
};

const updateMatchResult = async ({
  matchId,
  opponent1Score,
  opponent2Score,
  opponent1Forfeit = false,
  opponent2Forfeit = false,
  actorUsername,
  action,
  reason = "",
  env = process.env,
}) => {
  const manager = createManager(env);
  const match = await findMatch({ matchId, env });
  const group = await createStorage(env).select("group", match.group_id);
  if (![1, 2, 3].includes(Number(match.status))) {
    throw Object.assign(new Error("Only open matches can be scored."), {
      status: 400,
    });
  }
  getSide(match, "opponent1");
  getSide(match, "opponent2");
  const result = validateScoreResult({
    match,
    group,
    opponent1Score,
    opponent2Score,
  });

  await manager.update.match({
    id: Number(matchId),
    opponent1: {
      score: result.opponent1Score,
      result: result.winnerSide === "opponent1" ? "win" : "loss",
      ...(opponent1Forfeit ? { forfeit: true } : {}),
    },
    opponent2: {
      score: result.opponent2Score,
      result: result.winnerSide === "opponent2" ? "win" : "loss",
      ...(opponent2Forfeit ? { forfeit: true } : {}),
    },
  });

  await recordAudit({
    action,
    actorUsername,
    matchId: Number(matchId),
    reason,
    payload: {
      opponent1Score: result.opponent1Score,
      opponent2Score: result.opponent2Score,
      opponent1Forfeit,
      opponent2Forfeit,
    },
    env,
  });
  return getTourneyBracketSnapshot({ includeAudit: true, env });
};

export const scoreTourneyBracketMatch = async ({
  matchId,
  opponent1Score,
  opponent2Score,
  actorUsername,
  env = process.env,
} = {}) =>
  withBracketMutation({
    actorUsername,
    env,
    callback: () =>
      updateMatchResult({
        matchId,
        opponent1Score,
        opponent2Score,
        actorUsername,
        action: "match.score",
        env,
      }),
  });

export const forfeitTourneyBracketMatch = async ({
  matchId,
  losingSide,
  reason,
  actorUsername,
  env = process.env,
} = {}) =>
  withBracketMutation({
    actorUsername,
    env,
    callback: async () => {
      const match = await findMatch({ matchId, env });
      const group = await createStorage(env).select("group", match.group_id);
      getSide(match, losingSide);
      const target = getMatchTargetScore(match, group);
      const leftLoses = losingSide === "opponent1";
      return updateMatchResult({
        matchId,
        opponent1Score: leftLoses ? 0 : target,
        opponent2Score: leftLoses ? target : 0,
        opponent1Forfeit: leftLoses,
        opponent2Forfeit: !leftLoses,
        actorUsername,
        action: "match.forfeit",
        reason,
        env,
      });
    },
  });

const findTeamByParticipantId = ({ participantId, participants, teams }) => {
  const participant = participants.find((row) => row.id === participantId);
  if (!participant) return null;
  return teams.find((team) => normalizeKey(team.name) === normalizeKey(participant.name)) || null;
};

export const disqualifyTourneyBracketTeam = async ({
  teamId,
  matchId,
  reason,
  actorUsername,
  env = process.env,
} = {}) =>
  withBracketMutation({
    actorUsername,
    env,
    callback: async () => {
      const teams = await listTourneyBracketTeams({ includeDisqualified: true, env });
      const team = teams.find((row) => row.id === teamId);
      if (!team) {
        throw Object.assign(new Error("Team not found."), { status: 404 });
      }

      if (isMemoryMode(env)) {
        MEMORY_STORE.teams = MEMORY_STORE.teams.map((row) =>
          row.id === teamId ? { ...row, status: "disqualified" } : row
        );
      } else {
        await ensureTourneyBracketSchema(env);
        const sql = await getSql(env);
        await sql`
          update tourney_bracket_teams
          set status = 'disqualified',
              updated_at = now(),
              updated_by = ${normalizeKey(actorUsername)}
          where id = ${teamId}
        `;
      }

      const data = await readEngineData(env);
      const participants = data.participant || [];
      const participant = participants.find(
        (row) => normalizeKey(row.name) === normalizeKey(team.name)
      );
      const openMatch = (data.match || []).find((match) => {
        if (matchId && Number(match.id) !== Number(matchId)) return false;
        if (![1, 2, 3].includes(Number(match.status))) return false;
        return (
          match.opponent1?.id === participant?.id ||
          match.opponent2?.id === participant?.id
        );
      });

      await recordAudit({
        action: "team.disqualify",
        actorUsername,
        matchId: openMatch?.id ?? null,
        teamId,
        reason,
        payload: { teamName: team.name },
        env,
      });

      if (!openMatch) {
        return getTourneyBracketSnapshot({ includeAudit: true, env });
      }

      return updateMatchResult({
        matchId: openMatch.id,
        opponent1Score:
          openMatch.opponent1?.id === participant.id
            ? 0
            : getMatchTargetScore(
                openMatch,
                data.group.find((group) => group.id === openMatch.group_id)
              ),
        opponent2Score:
          openMatch.opponent2?.id === participant.id
            ? 0
            : getMatchTargetScore(
                openMatch,
                data.group.find((group) => group.id === openMatch.group_id)
              ),
        opponent1Forfeit: openMatch.opponent1?.id === participant.id,
        opponent2Forfeit: openMatch.opponent2?.id === participant.id,
        actorUsername,
        action: "match.disqualify",
        reason,
        env,
      });
    },
  });

const getDependentCompletedMatches = ({ match, matches }) => {
  const participantIds = [match.opponent1?.id, match.opponent2?.id].filter(
    (id) => id !== null && id !== undefined
  );
  return matches.filter((candidate) => {
    if (candidate.id === match.id || Number(candidate.status) !== 4) return false;
    return (
      participantIds.includes(candidate.opponent1?.id) ||
      participantIds.includes(candidate.opponent2?.id)
    );
  });
};

const getOpenMatchStatus = (match) => {
  const hasLeft = match?.opponent1?.id !== null && match?.opponent1?.id !== undefined;
  const hasRight = match?.opponent2?.id !== null && match?.opponent2?.id !== undefined;
  if (hasLeft && hasRight) return 2;
  if (hasLeft || hasRight) return 1;
  return 0;
};

const normalizeReopenedMatchStatus = async ({ storage, matchId }) => {
  const match = await storage.select("match", Number(matchId));
  if (!match) return;
  const cleanOpponent = (opponent) => {
    if (!opponent) return opponent;
    return {
      id: opponent.id,
      ...(opponent.position !== undefined ? { position: opponent.position } : {}),
    };
  };
  await storage.update("match", Number(matchId), {
    ...match,
    status: getOpenMatchStatus(match),
    opponent1: cleanOpponent(match.opponent1),
    opponent2: cleanOpponent(match.opponent2),
  });
};

export const reopenTourneyBracketMatch = async ({
  matchId,
  force = false,
  actorUsername,
  env = process.env,
} = {}) =>
  withBracketMutation({
    actorUsername,
    env,
    callback: async () => {
      const manager = createManager(env);
      const storage = createStorage(env);
      const target = await findMatch({ matchId, env });
      if (Number(target.status) !== 4 && Number(target.status) !== 5) {
        throw Object.assign(new Error("Only completed matches can be reopened."), {
          status: 400,
        });
      }
      const matches = await storage.select("match");
      const dependents = getDependentCompletedMatches({ match: target, matches });
      if (dependents.length > 0 && !force) {
        throw Object.assign(
          new Error("This match has completed downstream matches. Owner force reopen is required."),
          { status: 409 }
        );
      }
      if (force) {
        for (const dependent of dependents.sort((left, right) => right.id - left.id)) {
          await manager.reset.matchResults(dependent.id);
          await normalizeReopenedMatchStatus({ storage, matchId: dependent.id });
        }
      }
      await manager.reset.matchResults(Number(matchId));
      await normalizeReopenedMatchStatus({ storage, matchId });
      await recordAudit({
        action: force ? "match.force-reopen" : "match.reopen",
        actorUsername,
        matchId: Number(matchId),
        payload: { dependentMatchIds: dependents.map((match) => match.id) },
        env,
      });
      return getTourneyBracketSnapshot({ includeAudit: true, env });
    },
  });

export const resetTourneyBracket = async ({
  actorUsername,
  env = process.env,
} = {}) =>
  withBracketMutation({
    actorUsername,
    env,
    callback: async () => {
      await clearEngineData(env);
      await writeMeta({
        env,
        meta: {
          ...createDefaultMeta(),
          status: "draft",
          updatedAt: nowIso(),
          updatedBy: normalizeKey(actorUsername),
        },
      });
      await recordAudit({
        action: "bracket.reset",
        actorUsername,
        env,
      });
      return getTourneyBracketSnapshot({ includeAudit: true, env });
    },
  });

const getGroupRounds = ({ group, rounds }) =>
  rounds
    .filter((round) => round.group_id === group?.id)
    .sort((left, right) => left.number - right.number);

const getRoundDisplayName = ({ group, round, rounds }) => {
  const roundNumber = round?.number || 0;
  const groupRounds = getGroupRounds({ group, rounds });
  const finalRoundNumber =
    Math.max(...groupRounds.map((candidate) => candidate.number), roundNumber) ||
    roundNumber;
  const roundsFromFinal = finalRoundNumber - roundNumber;

  if (group?.number === 1) {
    if (roundsFromFinal === 0) return "Winners Final";
    if (roundsFromFinal === 1) return "Winners Semifinals";
    if (roundsFromFinal === 2) return "Winners Quarterfinals";
    return `Winners Round ${roundNumber}`;
  }

  if (group?.number === 2) {
    if (roundsFromFinal === 0) return "Lower Final";
    if (roundsFromFinal === 1) return "Lower Semifinal";
    return `Lower Round ${roundNumber}`;
  }

  if (group?.number === 3) return "Grand Final";
  return `Bracket Round ${roundNumber}`;
};

const singularStageName = (stageName) =>
  stageName
    .replace("Quarterfinals", "Quarterfinal")
    .replace("Semifinals", "Semifinal");

const getMatchDisplayLabel = ({ match, group, round, rounds, matches }) => {
  const stageName = getRoundDisplayName({ group, round, rounds });
  if (group?.number === 3) return "Grand Final";
  if (/Round \d+$/.test(stageName)) return `${stageName} Match ${match.number}`;

  const roundMatchCount = matches.filter(
    (candidate) => candidate.round_id === round?.id
  ).length;
  const label = singularStageName(stageName);
  return roundMatchCount > 1 ? `${label} ${match.number}` : label;
};

const buildNextLabels = ({ match, matches, rounds, groups }) => {
  if (Number(match.status) !== 4) return [];
  const labels = [];
  const sides = [
    ["Winner", match.opponent1?.result === "win" ? match.opponent1 : match.opponent2],
    ["Loser", match.opponent1?.result === "loss" ? match.opponent1 : match.opponent2],
  ];
  for (const [label, side] of sides) {
    if (!side?.id && side?.id !== 0) continue;
    const next = matches.find(
      (candidate) =>
        candidate.id !== match.id &&
        Number(candidate.status) !== 4 &&
        (candidate.opponent1?.id === side.id || candidate.opponent2?.id === side.id)
    );
    if (!next) continue;
    const round = rounds.find((row) => row.id === next.round_id);
    const group = groups.find((row) => row.id === next.group_id);
    labels.push(
      `${label} to ${getMatchDisplayLabel({
        match: next,
        group,
        round,
        rounds,
        matches,
      })}`
    );
  }
  return labels;
};

const buildDisplayMatches = ({ data, teams, maskParticipantNames = false }) => {
  const participants = data.participant || [];
  const groups = data.group || [];
  const rounds = data.round || [];
  const matches = data.match || [];

  return matches
    .map((match) => {
      const group = groups.find((row) => row.id === match.group_id);
      const round = rounds.find((row) => row.id === match.round_id);
      const side = (key) => {
        const opponent = match[key];
        const participant = participants.find((row) => row.id === opponent?.id);
        const team = findTeamByParticipantId({
          participantId: opponent?.id,
          participants,
          teams,
        });
        return {
          side: key,
          participantId: opponent?.id ?? null,
          teamId: team?.id || "",
          name: maskParticipantNames ? "TBD" : participant?.name || "TBD",
          score: opponent?.score ?? "",
          result: opponent?.result || (opponent?.forfeit ? "loss" : ""),
          forfeit: Boolean(opponent?.forfeit),
          status: team?.status || "",
        };
      };
      return {
        id: match.id,
        number: match.number,
        roundNumber: round?.number || 0,
        groupNumber: group?.number || 0,
        groupName: getGroupName(group),
        label: `${getGroupName(group)} R${round?.number || "?"} M${match.number}`,
        displayLabel: getMatchDisplayLabel({ match, group, round, rounds, matches }),
        status: match.status,
        statusLabel: MATCH_STATUSES[match.status] || "Unknown",
        bestOf: getMatchBestOf(match, group),
        targetScore: getMatchTargetScore(match, group),
        opponent1: side("opponent1"),
        opponent2: side("opponent2"),
        nextLabels: buildNextLabels({ match, matches, rounds, groups }),
      };
    })
    .sort((left, right) => {
      if (left.groupNumber !== right.groupNumber) return left.groupNumber - right.groupNumber;
      if (left.roundNumber !== right.roundNumber) return left.roundNumber - right.roundNumber;
      return left.number - right.number;
    });
};

const listAudit = async ({ env = process.env } = {}) => {
  if (isMemoryMode(env)) return MEMORY_STORE.audit.map(mapAuditRow).slice(0, 20);
  await ensureTourneyBracketSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    select *
    from tourney_bracket_audit
    order by created_at desc
    limit 20
  `;
  return rows.map(mapAuditRow);
};

export const getTourneyBracketSnapshot = async ({
  includeAudit = false,
  env = process.env,
} = {}) => {
  await ensurePreviewFixtureLoaded(env);

  const [meta, teams, data] = await Promise.all([
    readMeta(env),
    listTourneyBracketTeams({ includeDisqualified: true, env }),
    readEngineData(env),
  ]);
  const maskPreviewFixtureNames = isPreviewFixtureMode(env);
  return {
    ok: true,
    meta,
    teams: maskPreviewFixtureNames
      ? teams.map((team) => ({ ...team, name: "TBD" }))
      : teams,
    matches: buildDisplayMatches({
      data,
      teams,
      maskParticipantNames: maskPreviewFixtureNames,
    }),
    groups: (data.group || []).map((group) => ({
      id: group.id,
      number: group.number,
      name: getGroupName(group),
    })),
    generated: meta.stageId !== null,
    audit: includeAudit ? await listAudit({ env }) : [],
  };
};
