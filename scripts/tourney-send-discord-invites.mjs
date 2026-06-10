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
      import("../src/server/tourney/email.js"),
      import("../src/server/tourney/playerStore.js"),
    ]).then(([email, playerStore]) => ({ email, playerStore }));
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

const emailIdFromResult = (result) =>
  String(result?.id || result?.data?.id || "").trim();

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
  const { email } = await loadTourneyModules();
  const result = await email.sendTourneyDiscordInviteEmail({
    to: recipient,
    baseUrl,
    sampleMode: true,
    player: {
      id: "sample-player",
      version: "1",
      email: recipient,
      discord: "SampleParticipant#0000",
      displayName: "Sample Participant",
    },
  });

  printSummary({
    mode: "sample",
    sampleRecipient: recipient,
    sent: 1,
    emailId: emailIdFromResult(result) || null,
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
  const { email, playerStore } = await loadTourneyModules();
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
    sent: 0,
    failed: 0,
    participantRowsUpdated: 0,
  };

  if (!send) {
    printSummary(summary);
    return;
  }

  for (const player of targets) {
    try {
      const result = await email.sendTourneyDiscordInviteEmail({
        player,
        baseUrl,
      });
      await playerStore.markTourneyDiscordInviteEmailSent({
        playerId: player.id,
        emailId: emailIdFromResult(result),
      });
      summary.sent += 1;
      summary.participantRowsUpdated += 1;
    } catch (error) {
      await playerStore.markTourneyDiscordInviteEmailFailed({
        playerId: player.id,
        errorMessage: error?.message || "Unable to send Discord invite email.",
      });
      summary.failed += 1;
      summary.participantRowsUpdated += 1;
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
