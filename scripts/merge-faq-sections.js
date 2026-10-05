const { createClient } = require("@sanity/client");
const { loadOperatorEnvironment } = require("./lib/operator-environment.cjs");

const TARGET_ID = "faq";

async function run() {
  const args = process.argv.slice(2);
  const envIndex = args.indexOf("--env");
  const apply = args.includes("--apply");
  const deleteOld = args.includes("--delete-old");
  const flags = args.filter((_, index) => index !== envIndex + 1 || envIndex < 0);
  if (flags.some((arg) => !["--env", "--apply", "--delete-old"].includes(arg)) || deleteOld && !apply) throw new Error("FAQ mutation flags require --apply and --env.");
  loadOperatorEnvironment(envIndex >= 0 ? args[envIndex + 1] : "");
  const readEnv = (...keys) => keys.map((key) => String(process.env[key] || "").trim()).find(Boolean) || "";
  const projectId = readEnv("SANITY_PRIVATE_PROJECT_ID", "SANITY_PROJECT_ID");
  const dataset = readEnv("SANITY_PRIVATE_DATASET", "SANITY_DATASET");
  const writeToken = readEnv("SANITY_PRIVATE_WRITE_TOKEN", "SANITY_WRITE_TOKEN", "SANITY_AUTH_TOKEN");
  const token = apply ? writeToken : readEnv("SANITY_PRIVATE_READ_TOKEN", "SANITY_READ_TOKEN") || writeToken;
  if (!projectId || !dataset || !token) throw new Error("An explicit Sanity target and authenticated token are required.");
  const client = createClient({ projectId, dataset, token, useCdn: false,
    apiVersion: readEnv("SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION") || "2023-10-01" });
  const sections = await client.fetch(
    `*[_type == "faqSection"] | order(_createdAt asc) { _id, _rev, questions }`
  );

  const sourceSections = sections.filter((sec) => sec._id !== TARGET_ID);
  const mergeSource = sourceSections.length ? sourceSections : sections;
  const mergedQuestions = mergeSource.flatMap((sec) =>
    Array.isArray(sec.questions) ? sec.questions : []
  );

  if (!mergedQuestions.length) {
    console.log("No FAQ questions found to merge.");
    return;
  }

  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", questions: mergedQuestions.length, sourceSections: mergeSource.length }));
    return;
  }
  let transaction = client.transaction();
  const target = sections.find((section) => section._id === TARGET_ID);
  if (target) {
    if (!target._rev) throw new Error("The target FAQ revision is missing.");
    transaction = transaction.patch(TARGET_ID, (patch) => patch.ifRevisionId(target._rev).set({ questions: mergedQuestions }));
  } else {
    transaction = transaction.create({ _id: TARGET_ID, _type: "faqSection", questions: mergedQuestions });
  }
  const idsToDelete = deleteOld ? sourceSections.map((section) => section._id) : [];
  for (const section of deleteOld ? sourceSections : []) {
    if (!section._rev) throw new Error("A source FAQ revision is missing.");
    transaction = transaction.patch(section._id, (patch) => patch.ifRevisionId(section._rev).set({ questions: section.questions }));
    transaction = transaction.delete(section._id);
  }
  await transaction.commit({ visibility: "sync" });

  console.log(
    `Merged ${mergedQuestions.length} questions into FAQ document "${TARGET_ID}".`
  );

  if (idsToDelete.length) {
    console.log(`Deleted ${idsToDelete.length} old FAQ section documents.`);
  }
}

run().catch(() => {
  console.error("FAQ merge failed.");
  process.exit(1);
});
