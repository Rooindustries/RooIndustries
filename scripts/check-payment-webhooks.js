#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const ROOT = process.cwd();

const LOCAL_PATHS = [
  "app/api/payment/webhook/paypal/route.js",
  "app/api/payment/webhook/razorpay/route.js",
  "src/server/api/payment/webhookPayPal.js",
  "src/server/api/payment/webhookRazorpay.js",
  "src/server/api/payment/flow.js",
];

const REQUIRED_PROD_ENV = [
  "PAYPAL_WEBHOOK_ID",
  "RAZORPAY_WEBHOOK_SECRET",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "SANITY_WEBHOOK_SECRET",
];

const exists = (relativePath) => fs.existsSync(path.join(ROOT, relativePath));

const run = async (cmd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: ROOT,
      maxBuffer: 1024 * 1024,
    });
    return {
      ok: true,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || "").trim(),
      stderr: String(error.stderr || error.message || "").trim(),
    };
  }
};

const checkGitHistory = async (relativePath) => {
  const result = await run("git", ["rev-list", "--all", "--", relativePath]);
  if (!result.ok || !result.stdout) {
    return false;
  }
  return true;
};

const postUnsignedProbe = async (url) => {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{}",
    });

    return {
      ok: true,
      status: response.status,
      body: response.ok ? "" : "Probe refused or failed",
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: error.message,
    };
  }
};

const printSection = (title) => {
  console.log(`\n## ${title}`);
};

const printLine = (label, value) => {
  console.log(`- ${label}: ${value}`);
};

const main = async () => {
  const { localOrigin, refuseEnvFiles, installNetworkGuard } = await import("./lib/test-target-safety.mjs");
  refuseEnvFiles();
  const baseURL = localOrigin(process.env.BASE_URL);
  installNetworkGuard([baseURL]);
  const endpoints = [
    { label: "PayPal", url: `${baseURL}/api/payment/webhook/paypal` },
    { label: "Razorpay", url: `${baseURL}/api/payment/webhook/razorpay` },
  ];
  console.log("# Payment Webhook Check");
  printLine("Workspace", ROOT);

  printSection("Local source");
  for (const relativePath of LOCAL_PATHS) {
    const inTree = exists(relativePath);
    const inHistory = await checkGitHistory(relativePath);
    const status = inTree
      ? "present in current tree"
      : inHistory
        ? "missing in current tree, but exists in git history"
        : "not found in current tree or git history";
    printLine(relativePath, status);
  }

  printSection("Local credential presence");
  printLine("required vars present", REQUIRED_PROD_ENV.filter(name => Boolean(process.env[name])).join(", ") || "none");
  printSection("Explicit local endpoints");
  let probesPass = true;
  for (const endpoint of endpoints) {
    const probe = await postUnsignedProbe(endpoint.url);
    if (!probe.ok) {
      probesPass = false;
      printLine(endpoint.label, `probe failed (${probe.body})`);
      continue;
    }
    if (probe.status !== 401) probesPass = false;
    printLine(endpoint.label, `HTTP ${probe.status}`);
  }

  if (!probesPass) process.exitCode = 1;
  printSection("Summary");
  const localMissing = LOCAL_PATHS.filter((relativePath) => !exists(relativePath));
  if (localMissing.length > 0) {
    process.exitCode = 1;
    printLine(
      "deploy safety",
      "current tree is not webhook-safe to deploy without restoring missing webhook source files"
    );
  } else {
    printLine("deploy safety", "current tree contains the webhook source files");
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
