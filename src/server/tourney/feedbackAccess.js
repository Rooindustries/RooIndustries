import { timingSafeEqual } from "node:crypto";

export const TOURNEY_FEEDBACK_SLUG_HEADER = "x-tourney-feedback-slug";

const normalizeSlug = (value) => String(value || "").trim();

export const isTourneyFeedbackSlugValid = ({
  slug,
  env = process.env,
} = {}) => {
  const configured = normalizeSlug(env.TOURNEY_FEEDBACK_SLUG);
  const candidate = normalizeSlug(slug);
  if (configured.length < 24 || candidate.length !== configured.length) return false;

  const candidateBytes = Buffer.from(candidate);
  const configuredBytes = Buffer.from(configured);
  return candidateBytes.length === configuredBytes.length &&
    timingSafeEqual(candidateBytes, configuredBytes);
};
