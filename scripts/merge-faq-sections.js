const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@sanity/client");

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

const token =
  process.env.SANITY_AUTH_TOKEN ||
  process.env.REACT_APP_SANITY_WRITE_TOKEN ||
  process.env.SANITY_WRITE_TOKEN;

if (!token) {
  console.error(
    "Missing Sanity write token. Set SANITY_AUTH_TOKEN or REACT_APP_SANITY_WRITE_TOKEN."
  );
  process.exit(1);
}

const client = createClient({
  projectId: "9g42k3ur",
  dataset: "production",
  apiVersion: "2023-10-01",
  useCdn: false,
  token,
});

const TARGET_ID = "faq";

async function run() {
  const sections = await client.fetch(
    `*[_type == "faqSection"] | order(_createdAt asc) { _id, questions }`
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

  await client.createOrReplace({
    _id: TARGET_ID,
    _type: "faqSection",
    questions: mergedQuestions,
  });

  console.log(
    `Merged ${mergedQuestions.length} questions into FAQ document "${TARGET_ID}".`
  );

  if (!process.argv.includes("--delete-old")) return;

  const idsToDelete = sections
    .map((sec) => sec._id)
    .filter((id) => id !== TARGET_ID);

  for (const id of idsToDelete) {
    await client.delete(id);
  }

  if (idsToDelete.length) {
    console.log(`Deleted ${idsToDelete.length} old FAQ section documents.`);
  }
}

run().catch((err) => {
  console.error("FAQ merge failed:", err);
  process.exit(1);
});
