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
];

const LIVE_ENDPOINTS = [
  {
    label: "PayPal",
    url: "https://www.rooindustries.com/api/payment/webhook/paypal",
  },
  {
    label: "Razorpay",
    url: "https://www.rooindustries.com/api/payment/webhook/razorpay",
  },
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

const checkVercelEnv = async () => {
  const result = await run("vercel", ["env", "ls", "production"]);
  if (!result.ok) {
    return {
      ok: false,
      message: result.stderr || "Unable to query Vercel production env.",
      present: [],
    };
  }

  const present = REQUIRED_PROD_ENV.filter((name) => result.stdout.includes(name));
  return {
    ok: true,
    present,
    missing: REQUIRED_PROD_ENV.filter((name) => !present.includes(name)),
  };
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

    const text = (await response.text()).trim();
    return {
      ok: true,
      status: response.status,
      body: text.slice(0, 240),
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

  printSection("Production env");
  const envCheck = await checkVercelEnv();
  if (!envCheck.ok) {
    printLine("vercel env ls production", `unavailable (${envCheck.message})`);
  } else {
    printLine("required vars present", envCheck.present.join(", ") || "none");
    printLine("required vars missing", envCheck.missing.join(", ") || "none");
  }

  printSection("Live endpoints");
  for (const endpoint of LIVE_ENDPOINTS) {
    const probe = await postUnsignedProbe(endpoint.url);
    if (!probe.ok) {
      printLine(endpoint.label, `probe failed (${probe.body})`);
      continue;
    }
    printLine(endpoint.label, `HTTP ${probe.status} ${probe.body}`);
  }

  printSection("Summary");
  const localMissing = LOCAL_PATHS.filter((relativePath) => !exists(relativePath));
  if (localMissing.length > 0) {
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
