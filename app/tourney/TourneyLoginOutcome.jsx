const OUTCOME_COPY = Object.freeze({
  "discord-linked": "Discord linked. You're signed in.",
  "discord-link-failed":
    "Discord linking did not complete. Try the Discord login again.",
  "google-linked": "Google linked. You're signed in.",
  "google-link-failed":
    "Google linking did not complete. Try the Google login again.",
});

export default function TourneyLoginOutcome({ outcome = "" }) {
  const message = OUTCOME_COPY[String(outcome || "")];
  if (!message) return null;

  const success = String(outcome).endsWith("-linked");
  return (
    <section
      aria-label="Tournament sign-in outcome"
      aria-live="polite"
      className="tourney-status-panel tourney-form-narrow"
      role={success ? "status" : "alert"}
    >
      <p className="tourney-kicker">Account</p>
      <h3>{message}</h3>
    </section>
  );
}
