#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import dotenv from "dotenv";

const ENV_PATH = new URL("../.env.tourney-prod-fill.local", import.meta.url);
const TARGET_TEAM_NAMES = Object.freeze([
  "Putter",
  "Herloaf",
  "Wolfi",
  "Chosen",
  "R3nztu",
  "TapNoCap",
  "Apply",
  "HMP",
  "WSPS",
  "Mintthief",
  "Skinz",
  "Cookies",
]);
const ACTOR_USERNAME = "serviroo";
const UNSAFE_MATCH_STATUSES = new Set([3, 4, 5]);

const normalizeKey = (value) => String(value || "").trim().toLowerCase();
const hasRecordedScore = (side = {}) =>
  side.score !== "" && side.score !== null && side.score !== undefined;
const hasRecordedResult = (side = {}) => Boolean(String(side.result || "").trim());
const summarizeTeams = (teams = []) =>
  teams.map(({ name, seed, status }) => ({ name, seed, status }));
const printEvent = (event, payload) =>
  console.log(JSON.stringify({ event, ...payload }));

const main = async () => {
  const parsed = dotenv.parse(fs.readFileSync(ENV_PATH));
  const env = { ...parsed };
  delete env.NODE_ENV;
  delete env.TOURNEY_BRACKET_PREVIEW_FIXTURE;
  delete env.TOURNEY_BRACKET_STORE_MODE;

  const envChecks = {
    TOURNEY_DATABASE_MODE_SUPABASE:
      normalizeKey(env.TOURNEY_DATABASE_MODE) === "supabase",
    SUPABASE_DATABASE_URL_PRESENT: Boolean(env.SUPABASE_DATABASE_URL),
  };
  printEvent("env_checks", { checks: envChecks });
  if (!Object.values(envChecks).every(Boolean)) {
    throw Object.assign(new Error("Required production database variables are unavailable."), {
      code: "PRODUCTION_ENV_INVALID",
    });
  }

  const {
    deleteTourneyBracketTeam,
    generateTourneyBracket,
    getTourneyBracketSnapshot,
    listTourneyBracketTeams,
    resetTourneyBracket,
    seedTourneyBracketTeams,
    upsertTourneyBracketTeam,
  } = await import("../src/server/tourney/bracketStore.js");
  void deleteTourneyBracketTeam;
  void resetTourneyBracket;

  const beforeSnapshot = await getTourneyBracketSnapshot({ env });
  const scoredMatches = beforeSnapshot.matches.filter(
    (match) =>
      hasRecordedScore(match.opponent1) ||
      hasRecordedScore(match.opponent2) ||
      hasRecordedResult(match.opponent1) ||
      hasRecordedResult(match.opponent2)
  );
  const unsafeMatches = beforeSnapshot.matches.filter(
    (match) =>
      scoredMatches.some((scoredMatch) => scoredMatch.id === match.id) ||
      UNSAFE_MATCH_STATUSES.has(Number(match.status))
  );
  printEvent("before", {
    teams: summarizeTeams(beforeSnapshot.teams),
    generated: Boolean(beforeSnapshot.generated),
    meta: {
      stageId: beforeSnapshot.meta?.stageId ?? null,
      status: beforeSnapshot.meta?.status || "",
      published: Boolean(beforeSnapshot.meta?.published),
    },
    matchCount: beforeSnapshot.matches.length,
    scoredMatchIds: scoredMatches.map(({ id }) => id),
    unsafeMatchIds: unsafeMatches.map(({ id }) => id),
  });

  if (unsafeMatches.length > 0) {
    printEvent("aborted", {
      reason: "unsafe_matches",
      offendingMatchIds: unsafeMatches.map(({ id }) => id),
    });
    process.exitCode = 2;
    return;
  }

  const existing = await listTourneyBracketTeams({
    includeDisqualified: true,
    env,
  });
  const targetKeys = new Set(TARGET_TEAM_NAMES.map(normalizeKey));
  const staleTeams = existing.filter((team) => !targetKeys.has(normalizeKey(team.name)));
  if (staleTeams.length > 0) {
    printEvent("aborted", {
      reason: "stale_teams_require_destructive_deletion",
      staleTeams: summarizeTeams(staleTeams),
    });
    process.exitCode = 3;
    return;
  }

  const existingByName = new Map(
    existing.map((team) => [normalizeKey(team.name), team])
  );
  const orderedIds = [];
  for (const [index, name] of TARGET_TEAM_NAMES.entries()) {
    const current = existingByName.get(normalizeKey(name));
    const team = await upsertTourneyBracketTeam({
      ...(current ? { teamId: current.id } : {}),
      name,
      seed: index + 1,
      actorUsername: ACTOR_USERNAME,
      env,
    });
    orderedIds.push(team.id);
  }

  await seedTourneyBracketTeams({
    teamIds: orderedIds,
    actorUsername: ACTOR_USERNAME,
    env,
  });
  await generateTourneyBracket({
    actorUsername: ACTOR_USERNAME,
    env,
  });
  const afterSnapshot = await getTourneyBracketSnapshot({ env });
  printEvent("after", {
    teams: summarizeTeams(afterSnapshot.teams),
    generated: Boolean(afterSnapshot.generated),
    metaStatus: afterSnapshot.meta?.status || "",
    matchCount: afterSnapshot.matches.length,
  });
};

await main().catch((error) => {
  console.error(
    JSON.stringify({
      event: "error",
      code: String(error?.code || "BRACKET_FILL_FAILED"),
      status: Number(error?.status || 0),
      message:
        error?.code === "PRODUCTION_ENV_INVALID"
          ? "Required production database variables are unavailable."
          : "Production bracket fill failed during a guarded store operation.",
    })
  );
  process.exitCode = 1;
});
