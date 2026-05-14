/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error("[phase1-api-contract] BASE_URL is required");
  process.exit(1);
}

const csvEscape = (value) => {
  const raw = String(value ?? "");
  if (raw.includes(",") || raw.includes('"') || raw.includes("\n")) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
};

async function run() {
  const checks = [
    {
      route: "/api/bookingAvailability",
      method: "GET",
      expect: (response, body, hostDrift) =>
        response.status === 200 &&
        !hostDrift &&
        body?.ok === true &&
        typeof body?.settings === "object" &&
        Array.isArray(body?.bookedSlots),
    },
    {
      route: "/api/payment/providers",
      method: "GET",
      expect: (response, body, hostDrift) =>
        response.status === 200 &&
        !hostDrift &&
        body?.ok === true &&
        typeof body?.providers === "object",
    },
    {
      route: "/api/holdSlot",
      method: "POST",
      body: {},
      expect: (response, body, hostDrift) =>
        response.status === 400 &&
        !hostDrift &&
        /application\/json/i.test(response.headers.get("content-type") || "") &&
        typeof body?.message === "string",
    },
    {
      route: "/api/releaseHold",
      method: "POST",
      body: {},
      expect: (response, body, hostDrift) =>
        response.status === 400 &&
        !hostDrift &&
        /application\/json/i.test(response.headers.get("content-type") || "") &&
        typeof body?.message === "string",
    },
    {
      route: "/api/ref/validateReferral?code=nonexistent",
      method: "GET",
      expect: (response, body, hostDrift) =>
        response.status === 404 &&
        !hostDrift &&
        body?.ok === false,
    },
    {
      route: "/api/ref/createBooking",
      method: "POST",
      body: {},
      expect: (response, body, hostDrift) =>
        response.status === 400 &&
        !hostDrift &&
        /application\/json/i.test(response.headers.get("content-type") || "") &&
        typeof body?.error === "string",
    },
    {
      route: "/api/ref/getUpgradeInfo?id=nonexistent&email=test%40example.com",
      method: "GET",
      expect: (response, body, hostDrift) =>
        response.status === 404 &&
        !hostDrift &&
        body?.ok === false,
    },
    {
      route: "/api/razorpay/createOrder",
      method: "POST",
      body: {},
      expect: (response, body, hostDrift) =>
        (response.status === 400 || response.status === 500) &&
        !hostDrift &&
        typeof body?.ok === "boolean",
    },
    {
      route: "/api/razorpay/verify",
      method: "POST",
      body: {},
      expect: (response, body, hostDrift) =>
        response.status === 400 &&
        !hostDrift &&
        /application\/json/i.test(response.headers.get("content-type") || "") &&
        typeof body?.ok === "boolean",
    },
    {
      route: "/api/ref/cronSyncAll",
      method: "GET",
      expect: (response, body, hostDrift) =>
        response.status !== 404 &&
        !hostDrift &&
        /application\/json/i.test(response.headers.get("content-type") || "") &&
        typeof body?.ok === "boolean",
    },
    {
      route: "/api/ref/updatePayments",
      method: "POST",
      body: {},
      expect: (response, body, hostDrift) =>
        response.status !== 404 &&
        !hostDrift &&
        /application\/json/i.test(response.headers.get("content-type") || "") &&
        typeof body?.ok === "boolean",
    },
    {
      route: "/api/ref/updateBookingStatus",
      method: "POST",
      body: {},
      expect: (response, body, hostDrift) =>
        response.status !== 404 &&
        !hostDrift &&
        /application\/json/i.test(response.headers.get("content-type") || "") &&
        typeof body?.ok === "boolean",
    },
    {
      route: "/api/ref/syncPayouts",
      method: "POST",
      body: {},
      expect: (response, body, hostDrift) =>
        response.status !== 404 &&
        !hostDrift &&
        /application\/json/i.test(response.headers.get("content-type") || "") &&
        typeof body?.ok === "boolean",
    },
    {
      route: "/api/ref/webhookSync",
      method: "POST",
      body: {},
      expect: (response, body, hostDrift) =>
        response.status !== 404 &&
        !hostDrift &&
        /application\/json/i.test(response.headers.get("content-type") || "") &&
        typeof body?.ok === "boolean",
    },
  ];

  const rows = [];

  for (const check of checks) {
    const response = await fetch(`${BASE_URL}${check.route}`, {
      method: check.method,
      headers: {
        Accept: "application/json",
        ...(check.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(check.body ? { body: JSON.stringify(check.body) } : {}),
    });

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    const hostDrift = !response.url.startsWith(BASE_URL);
    rows.push({
      route: check.route,
      status: response.status,
      final_url: response.url,
      host_drift: hostDrift,
      content_type: response.headers.get("content-type") || "",
      body_ok_flag: typeof body?.ok === "boolean",
      has_error_text:
        typeof body?.error === "string" || typeof body?.message === "string",
      motherboards_array: Array.isArray(body?.motherboards),
      rams_array: Array.isArray(body?.rams),
      non_empty_keys: body ? Object.keys(body).length > 0 : false,
      pass: check.expect(response, body, hostDrift),
    });
  }

  const headers = [
    "route",
    "status",
    "final_url",
    "host_drift",
    "content_type",
    "body_ok_flag",
    "has_error_text",
    "motherboards_array",
    "rams_array",
    "non_empty_keys",
    "pass",
  ];

  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(",")),
  ];

  const auditDir = path.join(process.cwd(), "audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const out = path.join(auditDir, "phase1-api-contract.csv");
  fs.writeFileSync(out, `${lines.join("\n")}\n`);
  console.log(`[phase1-api-contract] wrote ${out}`);

  const failed = rows.filter((row) => !row.pass);
  if (failed.length > 0) {
    console.error("[phase1-api-contract] contract check failed", failed);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("[phase1-api-contract] failed:", err);
  process.exit(1);
});
