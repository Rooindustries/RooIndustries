import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const [, , orderId = "", email = ""] = process.argv;
if (!orderId || !email) {
  console.error("Usage: node scripts/check-download-lookup.mjs <orderId> <email>");
  process.exit(2);
}

const { validateDownloadAccess, createDownloadDataClient } = await import(
  "../src/server/downloads/downloadAccess.js"
);
const { resolveBookingFromSubmittedOrderId } = await import(
  "../src/server/api/ref/orderResolver.js"
);

const client = createDownloadDataClient();
const slug = process.env.DOWNLOAD_CHECK_SLUG || "utilities";
const booking = await resolveBookingFromSubmittedOrderId({ id: orderId, client });
if (!booking) {
  console.error(`No booking resolves from ${orderId}.`);
  process.exit(1);
}

const ids = [
  "_id",
  "orderId",
  "dodoPaymentId",
  "dodoCheckoutSessionId",
  "paypalOrderId",
  "razorpayOrderId",
  "razorpayPaymentId",
]
  .map((field) => [field, booking[field]])
  .filter(([, value]) => value);
const bare = booking._id.replace(/^booking[._]/, "");

const cases = [
  ...ids.map(([field, id]) => ({ label: `exact ${field}`, orderId: id, email, expect: 200 })),
  ...ids.map(([field, id]) => ({ label: `lowercase ${field}`, orderId: id.toLowerCase(), email, expect: 200 })),
  { label: "uppercase email", orderId: booking._id, email: email.toUpperCase(), expect: 200 },
  { label: "labelled Order ID", orderId: `Order ID: ${booking._id}.`, email, expect: 200 },
  { label: "quoted with spaces", orderId: ` "${booking._id} " `, email, expect: 200 },
  { label: "id without booking prefix", orderId: bare, email, expect: 200 },
  { label: "last 12 chars with email", orderId: booking._id.slice(-12), email, expect: 200 },
  { label: "guessable prefix booking.0 with email", orderId: `booking.${bare[0]}`, email, expect: 404, errorIncludes: "No paid booking found" },
  { label: "seven-char fragment with email", orderId: `booking.${bare.slice(0, 7)}`, email, expect: 404, errorIncludes: "No paid booking found" },
  { label: "bare generic prefix with email", orderId: "booking.", email, expect: 404, errorIncludes: "No paid booking found" },
  { label: "foreign id with email", orderId: "INV-0000-FOREIGN", email, expect: 404, errorIncludes: "No paid booking found" },
  { label: "right id wrong email", orderId: booking._id, email: "nobody@example.invalid", expect: 404, errorIncludes: "No paid booking found" },
  { label: "unknown id unknown email", orderId: "nothing-here-123", email: "nobody@example.invalid", expect: 404, errorIncludes: "No paid booking found" },
];

const results = [];
let failed = 0;
for (const testCase of cases) {
  const result = await validateDownloadAccess({
    slug,
    orderId: testCase.orderId,
    email: testCase.email,
    client,
    availabilityCheck: async () => true,
  });
  const error = result.body.error || "";
  const ok =
    result.status === testCase.expect &&
    (!testCase.errorIncludes || error.includes(testCase.errorIncludes)) &&
    (result.status !== 200 || result.body.booking.id === booking._id);
  if (!ok) failed += 1;
  results.push({ ...testCase, status: result.status, error, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${testCase.label} -> ${result.status} ${error}`);
}

const artifact = {
  checkedAt: new Date().toISOString(),
  slug,
  passed: results.length - failed,
  failed,
  results: results.map(({ label, expect, status, ok }) => ({ label, expect, status, ok })),
};
fs.mkdirSync("output", { recursive: true });
fs.writeFileSync("output/download-lookup-check.json", JSON.stringify(artifact, null, 2));
console.log(`\n${artifact.passed}/${results.length} passed. Artifact: output/download-lookup-check.json`);
process.exit(failed ? 1 : 0);
