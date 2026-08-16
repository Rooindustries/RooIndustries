"use client";

import { useState } from "react";
import { tourneyMutationFetch } from "./tourneyMutation";

const ratingFields = [
  { field: "overallRating", label: "Overall Tourney experience" },
  { field: "organizationRating", label: "Organisation and match flow" },
  { field: "communicationRating", label: "Communication and scheduling" },
  { field: "formatRating", label: "Matches and competitive format" },
];

const returnLabels = {
  yes: "Yes",
  maybe: "Maybe",
  no: "No",
};

const initialForm = {
  overallRating: "",
  organizationRating: "",
  communicationRating: "",
  formatRating: "",
  broadcastRating: "",
  returnIntent: "",
  feedbackText: "",
};

const formatSubmittedAt = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Submitted";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "UTC",
    timeZoneName: "short",
    year: "numeric",
  }).format(date);
};

const RatingField = ({ field, label, value, onChange }) => (
  <fieldset className="tourney-feedback-rating">
    <legend>{label}</legend>
    <div className="tourney-rating-scale" aria-label={`${label}: 1 is poor, 5 is excellent`}>
      {[1, 2, 3, 4, 5].map((rating) => (
        <label
          className={String(value) === String(rating) ? "is-selected" : ""}
          key={rating}
        >
          <input
            checked={String(value) === String(rating)}
            name={field}
            onChange={() => onChange(field, String(rating))}
            required
            type="radio"
            value={rating}
          />
          <span>{rating}</span>
        </label>
      ))}
    </div>
    <div className="tourney-rating-ends" aria-hidden="true">
      <span>Poor</span>
      <span>Excellent</span>
    </div>
  </fieldset>
);

const FeedbackReceipt = ({ feedback }) => (
  <div className="tourney-feedback-receipt" role="status">
    <p className="tourney-kicker">Anonymous response received</p>
    <h3>Thank you for helping us improve.</h3>
    <p>
      Your feedback is saved without your Tourney account, name, team, or
      Discord handle attached to it.
    </p>
    <dl>
      <div>
        <dt>Receipt</dt>
        <dd>{feedback.id}</dd>
      </div>
      <div>
        <dt>Overall rating</dt>
        <dd>{feedback.overallRating}/5</dd>
      </div>
      <div>
        <dt>Submitted</dt>
        <dd>{formatSubmittedAt(feedback.createdAt)}</dd>
      </div>
    </dl>
  </div>
);

export default function TourneyFeedbackPanel({ previewMode = false, feedbackSlug = "" }) {
  const [form, setForm] = useState(initialForm);
  const [submittedFeedback, setSubmittedFeedback] = useState(null);
  const [message, setMessage] = useState("");
  const [isSuccess, setIsSuccess] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsBusy(true);
    setIsSuccess(false);
    setMessage("");
    if (previewMode) {
      setSubmittedFeedback({
        id: globalThis.crypto?.randomUUID?.() || `feedback-${Date.now()}`,
        overallRating: Number(form.overallRating),
        createdAt: new Date().toISOString(),
      });
      setIsSuccess(true);
      setMessage("Anonymous feedback received. Thank you for being part of the Tourney.");
      setIsBusy(false);
      return;
    }
    try {
      const response = await tourneyMutationFetch("/api/tourney/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tourney-Feedback-Slug": feedbackSlug,
        },
        body: JSON.stringify(form),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || "Unable to save feedback.");
      }
      setSubmittedFeedback(data.feedback || null);
      setIsSuccess(true);
      setMessage("Anonymous feedback received. Thank you for being part of the Tourney.");
    } catch (error) {
      setMessage(error?.message || "Unable to save feedback.");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="tourney-record-panel tourney-feedback-panel">
      {submittedFeedback ? (
        <FeedbackReceipt feedback={submittedFeedback} />
      ) : (
        <form className="tourney-owner-form tourney-feedback-form" onSubmit={handleSubmit}>
          <div className="tourney-feedback-preview-note" role="note">
            <strong>Anonymous. No sign-in required.</strong>
            <span>
              This form does not ask for or attach your Tourney account, name,
              team, email, or Discord handle.
            </span>
          </div>

          <div className="tourney-feedback-form-heading">
            <p className="tourney-kicker">For Tourney participants</p>
            <h3>Give us the honest version.</h3>
            <p>
              Rate your experience, then tell us plainly what was bad or what
              should be better next time.
            </p>
          </div>

          <div className="tourney-feedback-ratings">
            {ratingFields.map((rating) => (
              <RatingField
                {...rating}
                key={rating.field}
                onChange={updateField}
                value={form[rating.field]}
              />
            ))}
          </div>

          <label>
            Broadcast and casting <span className="tourney-optional">Optional</span>
            <select
              onChange={(event) => updateField("broadcastRating", event.target.value)}
              value={form.broadcastRating}
            >
              <option value="">I did not watch enough to rate it</option>
              {[5, 4, 3, 2, 1].map((rating) => (
                <option key={rating} value={rating}>{rating}/5</option>
              ))}
            </select>
          </label>

          <fieldset className="tourney-feedback-return">
            <legend>Would you take part in another Roo Industries Tourney?</legend>
            <div>
              {Object.entries(returnLabels).map(([value, label]) => (
                <label className={form.returnIntent === value ? "is-selected" : ""} key={value}>
                  <input
                    checked={form.returnIntent === value}
                    name="returnIntent"
                    onChange={() => updateField("returnIntent", value)}
                    required
                    type="radio"
                    value={value}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label>
            What was bad, or what should we improve?
            <textarea
              maxLength={3000}
              minLength={3}
              onChange={(event) => updateField("feedbackText", event.target.value)}
              placeholder="Scheduling, rules, communication, production, match flow, or anything else we should fix..."
              required
              rows={7}
              value={form.feedbackText}
            />
          </label>

          <p className="tourney-feedback-privacy">
            Only the tournament organisers can read individual responses. If
            you want to stay anonymous, do not identify yourself in the written
            feedback.
          </p>
          <button className="tourney-owner-button" disabled={isBusy} type="submit">
            {isBusy ? "Sending..." : "Send anonymous feedback"}
          </button>
        </form>
      )}

      {message ? (
        <p
          className={isSuccess ? "tourney-form-message is-success" : "tourney-form-message"}
          role={isSuccess ? "status" : "alert"}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
