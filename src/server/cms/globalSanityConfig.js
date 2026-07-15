import {
  GLOBAL_SANITY_DATASET,
  GLOBAL_SANITY_PROJECT_ID,
} from "../../lib/globalCmsContract.js";

const clean = (value) => String(value || "").trim();
const firstClean = (...values) => values.map(clean).find(Boolean) || "";
const matchesGlobalTarget = (candidate) =>
  candidate.projectId === GLOBAL_SANITY_PROJECT_ID &&
  candidate.dataset === GLOBAL_SANITY_DATASET;

const privateTarget = (env, token) => ({
  projectId: clean(env.SANITY_PRIVATE_PROJECT_ID),
  dataset: clean(env.SANITY_PRIVATE_DATASET),
  apiVersion: clean(env.SANITY_PRIVATE_API_VERSION) || "2026-07-01",
  token: clean(token),
});

const standardTarget = (env) => ({
  projectId: clean(env.SANITY_PROJECT_ID),
  dataset: clean(env.SANITY_DATASET),
  apiVersion: clean(env.SANITY_API_VERSION) || "2026-07-01",
  token: firstClean(env.SANITY_READ_TOKEN, env.SANITY_WRITE_TOKEN),
});

const publicTarget = (env) => ({
  projectId: clean(env.NEXT_PUBLIC_SANITY_PROJECT_ID),
  dataset: clean(env.NEXT_PUBLIC_SANITY_DATASET),
  apiVersion: clean(env.SANITY_API_VERSION) || "2026-07-01",
  token: "",
});

export const resolveGlobalSanityReadConfig = (env = process.env) => {
  const privateCandidate = privateTarget(
    env,
    firstClean(env.SANITY_PRIVATE_READ_TOKEN, env.SANITY_PRIVATE_WRITE_TOKEN),
  );
  const standardCandidate = standardTarget(env);
  const publicCandidate = publicTarget(env);
  const exact = [privateCandidate, standardCandidate, publicCandidate].find(
    (candidate) =>
      candidate.projectId &&
      candidate.dataset &&
      matchesGlobalTarget(candidate) &&
      (candidate !== privateCandidate || candidate.token),
  );
  if (exact) return exact;
  if (
    clean(env.NODE_ENV).toLowerCase() === "production" ||
    clean(env.VERCEL_ENV).toLowerCase() === "production"
  ) {
    return null;
  }
  if (standardCandidate.projectId && standardCandidate.dataset) {
    return standardCandidate;
  }
  if (publicCandidate.projectId && publicCandidate.dataset) {
    return publicCandidate;
  }
  return null;
};

export const resolveGlobalSanityWriteConfig = (env = process.env) =>
  [
    privateTarget(env, env.SANITY_PRIVATE_WRITE_TOKEN),
    {
      ...standardTarget(env),
      token: clean(env.SANITY_WRITE_TOKEN),
    },
  ].find(
    (candidate) =>
      candidate.projectId &&
      candidate.dataset &&
      candidate.token &&
      matchesGlobalTarget(candidate),
  ) || null;
