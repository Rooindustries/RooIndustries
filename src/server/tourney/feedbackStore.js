import {
  createTourneyAppeal,
  listTourneyAppealsForSession,
} from "./appealPayoutStore.js";

export const TOURNEY_FEEDBACK_MARKER = "roo-tourney-participant-feedback-v1";
export const TOURNEY_FEEDBACK_RETURN_OPTIONS = Object.freeze([
  "yes",
  "maybe",
  "no",
]);

const REQUIRED_RATINGS = Object.freeze([
  "overallRating",
  "organizationRating",
  "communicationRating",
  "formatRating",
]);
const ANONYMOUS_FEEDBACK_SESSION = Object.freeze({
  username: "anonymous-participant",
  role: "player",
  playerId: "",
});

const normalizeText = (value) => String(value || "").trim();
const normalizeChoice = (value, choices) => {
  const normalized = normalizeText(value).toLowerCase();
  return choices.includes(normalized) ? normalized : "";
};
const normalizeRating = (value, { optional = false } = {}) => {
  if (optional && normalizeText(value) === "") return null;
  const rating = Number(value);
  return Number.isInteger(rating) && rating >= 1 && rating <= 5
    ? rating
    : null;
};

const feedbackError = (errors) => {
  const error = new Error(errors[0] || "Check your feedback and try again.");
  error.status = 400;
  error.errors = errors;
  return error;
};

export const validateTourneyFeedbackPayload = (payload = {}) => {
  const returnIntent = normalizeChoice(
    payload.returnIntent,
    TOURNEY_FEEDBACK_RETURN_OPTIONS
  );
  const ratings = Object.fromEntries(
    REQUIRED_RATINGS.map((field) => [field, normalizeRating(payload[field])])
  );
  const broadcastRating = normalizeRating(payload.broadcastRating, {
    optional: true,
  });
  const feedbackText = normalizeText(payload.feedbackText);
  const errors = [];

  for (const field of REQUIRED_RATINGS) {
    if (ratings[field] === null) errors.push("Give every required rating from 1 to 5.");
  }
  if (!returnIntent) errors.push("Tell us whether you would take part again.");
  if (feedbackText.length < 3) {
    errors.push("Tell us what was bad or what we should improve.");
  }
  if (feedbackText.length > 3000) {
    errors.push("Written feedback must be 3,000 characters or less.");
  }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    value: {
      ...ratings,
      broadcastRating,
      returnIntent,
      feedbackText,
    },
  };
};

const parseFeedbackDetails = (details) => {
  try {
    const parsed = JSON.parse(String(details || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
};

const readFeedbackText = (details) => {
  const current = normalizeText(details.feedbackText);
  if (current) return current;
  return [details.improvement, details.highlight, details.comments]
    .map(normalizeText)
    .filter(Boolean)
    .join("\n\n");
};

const mapFeedback = (appeal) => {
  if (appeal?.subjectName !== TOURNEY_FEEDBACK_MARKER) return null;
  const details = parseFeedbackDetails(appeal.details);
  if (!details) return null;
  return {
    id: appeal.id,
    overallRating: normalizeRating(details.overallRating),
    organizationRating: normalizeRating(details.organizationRating),
    communicationRating: normalizeRating(details.communicationRating),
    formatRating: normalizeRating(details.formatRating),
    broadcastRating: normalizeRating(details.broadcastRating, { optional: true }),
    returnIntent: normalizeChoice(
      details.returnIntent,
      TOURNEY_FEEDBACK_RETURN_OPTIONS
    ),
    feedbackText: readFeedbackText(details),
    createdAt: appeal.createdAt,
  };
};

export const createTourneyFeedback = async ({
  payload,
  env = process.env,
} = {}) => {
  const validation = validateTourneyFeedbackPayload(payload);
  if (!validation.ok) throw feedbackError(validation.errors);
  const value = validation.value;

  // Feedback remains separate from historical appeals through the marker, but
  // the record deliberately carries no Tourney account, player, team, or name.
  const appeal = await createTourneyAppeal({
    payload: {
      type: "team-appeal",
      title: `Anonymous Tourney feedback · ${value.overallRating}/5`,
      subjectName: TOURNEY_FEEDBACK_MARKER,
      details: JSON.stringify(value),
    },
    session: ANONYMOUS_FEEDBACK_SESSION,
    env,
  });
  return mapFeedback(appeal);
};

export const listTourneyFeedbackForSession = async ({
  session,
  env = process.env,
} = {}) => {
  const appeals = await listTourneyAppealsForSession({ session, env });
  return appeals.map(mapFeedback).filter(Boolean);
};
