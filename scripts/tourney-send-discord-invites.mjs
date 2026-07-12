#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";

if (
  !process.env.TOURNEY_DISCORD_INVITE_NO_WARNINGS_REEXEC &&
  !process.execArgv.includes("--no-warnings")
) {
  const result = spawnSync(process.execPath, [
    "--no-warnings",
    ...process.argv.slice(1),
  ], {
    stdio: "inherit",
    env: {
      ...process.env,
      TOURNEY_DISCORD_INVITE_NO_WARNINGS_REEXEC: "1",
    },
  });
  process.exit(result.status ?? 1);
}

dotenv.config({ path: ".env.local", quiet: true });

process.on("warning", (warning) => {
  if (warning?.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(warning?.stack || warning?.message || String(warning));
});

const SAMPLE_TO = "serviroo@rooindustries.com";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let tourneyModulesPromise = null;

const loadTourneyModules = async () => {
  if (!tourneyModulesPromise) {
    tourneyModulesPromise = Promise.all([
      import("../src/server/tourney/emailDispatch.js"),
      import("../src/server/tourney/playerStore.js"),
      import("../src/server/tourney/store.js"),
    ]).then(([emailDispatch, playerStore, store]) => ({
      emailDispatch,
      playerStore,
      store,
    }));
  }
  return tourneyModulesPromise;
};

const parseArgs = (argv) => {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) continue;

    const key = entry.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }
  return flags;
};

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const isFlagTrue = (value) => value === true || String(value || "") === "true";

const resolveBaseUrl = () => {
  const configured = String(
    process.env.TOURNEY_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || ""
  ).trim();
  if (configured) return configured;
  const vercelUrl = String(process.env.VERCEL_URL || "").trim();
  if (vercelUrl) return `https://${vercelUrl}`;
  return "https://www.rooindustries.com";
};

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const printSummary = (summary) => {
  console.log(JSON.stringify(summary, null, 2));
};

const validateSampleRecipient = (value) => {
  const email = normalizeEmail(value);
  if (email !== SAMPLE_TO) {
    throw new Error(`Sample email recipient must be exactly ${SAMPLE_TO}.`);
  }
  return email;
};

const sendSample = async ({ sampleTo, baseUrl }) => {
  const recipient = validateSampleRecipient(sampleTo);
  const { emailDispatch, store } = await loadTourneyModules();
  const player = {
    id: "sample-player",
    version: "1",
    email: recipient,
    discord: "SampleParticipant#0000",
    displayName: "Sample Participant",
  };
  await store.executeTourneyCommand({
    commandId: "discord-invite:sample:sample-player:v1",
    purpose: "email:discord-invite",
    requestPayload: { playerId: player.id, sample: true },
    attemptExternalWork: false,
    callback: () => emailDispatch.enqueueTourneyEmailDispatch({
      commandId: "discord-invite:sample:sample-player:v1",
      dispatchKind: "discord_invite",
      recipient,
      entityType: "player",
      entityId: player.id,
      entityVersion: player.version,
      payload: { to: recipient, baseUrl, sampleMode: true, player },
    }).then(() => ({ body: { ok: true } })),
  });

  printSummary({
    mode: "sample",
    sampleRecipient: recipient,
    queued: 1,
    participantRowsUpdated: 0,
  });
};

const dedupeRecipients = (players) => {
  const seen = new Set();
  const deduped = [];
  let skippedInvalidEmail = 0;
  let skippedDuplicateEmail = 0;

  for (const player of players) {
    const email = normalizeEmail(player.email);
    if (!EMAIL_PATTERN.test(email)) {
      skippedInvalidEmail += 1;
      continue;
    }
    if (seen.has(email)) {
      skippedDuplicateEmail += 1;
      continue;
    }
    seen.add(email);
    deduped.push({ ...player, email });
  }

  return { deduped, skippedInvalidEmail, skippedDuplicateEmail };
};

const sendBatch = async ({
  send,
  baseUrl,
  onlyEmail,
  force,
  limit,
  throttleMs,
}) => {
  const { emailDispatch, playerStore, store } = await loadTourneyModules();
  const players = await playerStore.listApprovedTourneyDiscordInviteRecipients({
    includeAlreadySent: force,
    onlyEmail,
    limit: limit > 0 ? limit * 2 : 0,
  });
  const { deduped, skippedInvalidEmail, skippedDuplicateEmail } =
    dedupeRecipients(players);
  const targets = limit > 0 ? deduped.slice(0, limit) : deduped;
  const summary = {
    mode: send ? "send" : "dry-run",
    approvedRowsMatched: players.length,
    targetRecipients: targets.length,
    skippedInvalidEmail,
    skippedDuplicateEmail,
    queued: 0,
    failed: 0,
    participantRowsUpdated: 0,
  };

  if (!send) {
    printSummary(summary);
    return;
  }

  for (const player of targets) {
    try {
      const commandId = `discord-invite:${player.id}:v${player.version || 1}`;
      await store.executeTourneyCommand({
        commandId,
        purpose: "email:discord-invite",
        requestPayload: { playerId: player.id, version: player.version || 1 },
        attemptExternalWork: false,
        callback: () => emailDispatch.enqueueTourneyEmailDispatch({
          commandId,
          dispatchKind: "discord_invite",
          recipient: player.email,
          entityType: "player",
          entityId: player.id,
          entityVersion: player.version || 1,
          payload: { player, to: player.email, baseUrl },
        }).then(() => ({ body: { ok: true } })),
      });
      summary.queued += 1;
    } catch (error) {
      summary.failed += 1;
    }

    if (throttleMs > 0) {
      await sleep(throttleMs);
    }
  }

  printSummary(summary);
};

const main = async () => {
  const flags = parseArgs(process.argv.slice(2));
  const baseUrl = String(flags["base-url"] || resolveBaseUrl()).trim();
  const sampleTo = flags["sample-to"] ? String(flags["sample-to"]) : "";
  const limit = Math.max(0, Number(flags.limit || 0) || 0);
  const throttleMs = Math.max(0, Number(flags["throttle-ms"] || 500) || 0);
  const onlyEmail = normalizeEmail(flags.only);

  if (sampleTo) {
    await sendSample({ sampleTo, baseUrl });
    return;
  }

  await sendBatch({
    send: isFlagTrue(flags.send),
    baseUrl,
    onlyEmail,
    force: isFlagTrue(flags.force),
    limit,
    throttleMs,
  });
};

main().catch((error) => {
  console.error(`[tourney-send-discord-invites] ${error.message}`);
  process.exit(1);
});
