"use client";

import { useEffect, useState } from "react";

const rankOptions = [
  "Master",
  "Grandmaster",
  "Champion",
];

const roleOptions = ["Tank", "Damage", "Support", "Flex"];

const timezoneOptions = [
  "Pacific Time (PT)",
  "Mountain Time (MT)",
  "Central Time (CT)",
  "Eastern Time (ET)",
  "Atlantic Time (AT)",
  "Alaska Time (AKT)",
  "Hawaii Time (HT)",
  "UTC / GMT",
  "UK / Ireland (BST/GMT)",
  "Central Europe (CET/CEST)",
  "Eastern Europe (EET/EEST)",
  "Turkey (TRT)",
  "Gulf Standard Time (GST)",
  "India Standard Time (IST)",
  "SE Asia (ICT/WIB)",
  "Singapore / China (SGT/CST)",
  "Japan / Korea (JST/KST)",
  "Australian Western (AWST)",
  "Australian Eastern (AEST/AEDT)",
  "New Zealand (NZST/NZDT)",
  "Brazil (BRT)",
  "Argentina (ART)",
  "Other / not listed",
];

const initialForm = {
  email: "",
  password: "",
  passwordConfirm: "",
  discord: "",
  displayName: "",
  battlenet: "",
  rank: "",
  rolePlay: "",
  timezone: "",
  twitchUsername: "",
  availableAug12: false,
  acceptedRules: false,
  acceptedRooVisibility: false,
  notes: "",
};

const hydrationSafeControlProps = { suppressHydrationWarning: true };

export default function TourneyRegistrationForm({
  registrationClosed = false,
  registrationClosesAt = "",
}) {
  const [form, setForm] = useState(initialForm);
  const [message, setMessage] = useState("");
  const [isSuccess, setIsSuccess] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [capacityConflict, setCapacityConflict] = useState(null);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const submitRegistration = async ({ acceptSubstitutePool = false } = {}) => {
    setIsBusy(true);
    setMessage("");
    setIsSuccess(false);

    try {
      if (form.password !== form.passwordConfirm) {
        throw new Error("Passwords must match.");
      }

      const response = await fetch("/api/tourney/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, acceptSubstitutePool }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        if (response.status === 409 && data.code === "ROLE_CAPACITY_FULL") {
          setCapacityConflict(data.capacity || { role: form.rolePlay });
          return;
        }
        throw new Error(data.error || "Unable to submit registration.");
      }

      setForm(initialForm);
      setCapacityConflict(null);
      setMessage(data.message || "Registration submitted.");
      setIsSuccess(true);
    } catch (error) {
      setMessage(error?.message || "Unable to submit registration.");
    } finally {
      setIsBusy(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    await submitRegistration();
  };

  const handleJoinSubstitutePool = async () => {
    setCapacityConflict(null);
    await submitRegistration({ acceptSubstitutePool: true });
  };

  const handleChangeRole = () => {
    setCapacityConflict(null);
    const roleField = document.querySelector("[name='rolePlay']");
    if (roleField) roleField.focus();
  };

  if (registrationClosed) {
    return (
      <div className="tourney-status-panel">
        <p className="tourney-kicker">Closed</p>
        <h3>Registration is closed</h3>
        <p>
          Registration closed on{" "}
          <time dateTime={registrationClosesAt}>July 22, 2026 at 00:00 UTC</time>.
          Drafts are July 25, 2026 with the exact draft time still TBD.
        </p>
      </div>
    );
  }

  if (!isHydrated) {
    return (
      <div className="tourney-status-panel">
        <p className="tourney-kicker">Registration</p>
        <h3>Loading registration form</h3>
      </div>
    );
  }

  return (
    <form className="tourney-form" onSubmit={handleSubmit}>
      <p className="tourney-form-note">
        Registration closes{" "}
        <time dateTime={registrationClosesAt}>July 22, 2026 at 00:00 UTC</time>.
        Drafts happen July 25, 2026 at a TBD time.
      </p>
      <div className="tourney-form-grid">
        <label>
          Discord Username
          <input
            {...hydrationSafeControlProps}
            type="text"
            autoComplete="username"
            required
            minLength={3}
            value={form.discord}
            onChange={(event) => updateField("discord", event.target.value)}
          />
        </label>
        <label>
          Display Name
          <input
            {...hydrationSafeControlProps}
            type="text"
            autoComplete="nickname"
            required
            minLength={2}
            value={form.displayName}
            onChange={(event) => updateField("displayName", event.target.value)}
          />
        </label>
        <label>
          Email
          <input
            {...hydrationSafeControlProps}
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={(event) => updateField("email", event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            {...hydrationSafeControlProps}
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={form.password}
            onChange={(event) => updateField("password", event.target.value)}
          />
        </label>
        <label>
          Confirm password
          <input
            {...hydrationSafeControlProps}
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={form.passwordConfirm}
            onChange={(event) => updateField("passwordConfirm", event.target.value)}
          />
        </label>
        <label>
          Battle.net BattleTag
          <input
            {...hydrationSafeControlProps}
            type="text"
            autoComplete="off"
            required
            value={form.battlenet}
            onChange={(event) => updateField("battlenet", event.target.value)}
          />
        </label>
        <label>
          Current Overwatch rank
          <select
            {...hydrationSafeControlProps}
            required
            value={form.rank}
            onChange={(event) => updateField("rank", event.target.value)}
          >
            <option value="">Choose rank</option>
            {rankOptions.map((rank) => (
              <option key={rank} value={rank}>
                {rank}
              </option>
            ))}
          </select>
        </label>
        <label>
          Primary Role
          <select
            {...hydrationSafeControlProps}
            name="rolePlay"
            required
            value={form.rolePlay}
            onChange={(event) => updateField("rolePlay", event.target.value)}
          >
            <option value="">Choose role</option>
            {roleOptions.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        <label>
          Timezone
          <select
            {...hydrationSafeControlProps}
            required
            value={form.timezone}
            onChange={(event) => updateField("timezone", event.target.value)}
          >
            <option value="">Choose timezone</option>
            {timezoneOptions.map((timezone) => (
              <option key={timezone} value={timezone}>
                {timezone}
              </option>
            ))}
          </select>
        </label>
        <label>
          Twitch Username
          <span className="tourney-prefixed-input">
            <span aria-hidden="true">twitch.tv/</span>
            <input
              {...hydrationSafeControlProps}
              type="text"
              autoComplete="off"
              maxLength={25}
              minLength={3}
              pattern="[A-Za-z0-9_]{3,25}"
              placeholder="skinz_ow"
              required
              value={form.twitchUsername}
              onChange={(event) => updateField("twitchUsername", event.target.value)}
            />
          </span>
        </label>
      </div>

      <label className="tourney-checkbox">
        <input
          {...hydrationSafeControlProps}
          name="availableAug12"
          type="checkbox"
          required
          checked={form.availableAug12}
          onChange={(event) => updateField("availableAug12", event.target.checked)}
        />
        <span>Are you free on August 15th and 16th?</span>
      </label>

      <label className="tourney-checkbox">
        <input
          {...hydrationSafeControlProps}
          name="acceptedRules"
          type="checkbox"
          required
          checked={form.acceptedRules}
          onChange={(event) => updateField("acceptedRules", event.target.checked)}
        />
        <span>I have read the tournament rules and agree to follow them.</span>
      </label>

      <label className="tourney-checkbox">
        <input
          {...hydrationSafeControlProps}
          name="acceptedRooVisibility"
          type="checkbox"
          required
          checked={form.acceptedRooVisibility}
          onChange={(event) =>
            updateField("acceptedRooVisibility", event.target.checked)
          }
        />
        <span>
          I understand the event stream or Discord may include a small pinned
          message, command, or banner linking to rooindustries.com so viewers can
          find the event hub, giveaways, and Roo Industries info.
        </span>
      </label>

      <label>
        Extra notes
        <textarea
          {...hydrationSafeControlProps}
          rows={5}
          value={form.notes}
          onChange={(event) => updateField("notes", event.target.value)}
        />
      </label>

      <button className="tourney-owner-button" type="submit" disabled={isBusy}>
        {isBusy ? "Submitting..." : "Submit registration"}
      </button>

      {message ? (
        <p
          className={isSuccess ? "tourney-form-message is-success" : "tourney-form-message"}
          role="status"
        >
          {message}
        </p>
      ) : null}

      {capacityConflict ? (
        <div
          className="tourney-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) handleChangeRole();
          }}
        >
          <div
            aria-labelledby="tourney-capacity-title"
            aria-modal="true"
            className="tourney-modal"
            role="dialog"
          >
            <p className="tourney-kicker">Substitute Pool</p>
            <h3 id="tourney-capacity-title">{capacityConflict.role} is full</h3>
            <p>
              This role is at maximum capacity for the main bracket. You can
              still register and be added to the substitute pool.
            </p>
            <div className="tourney-modal-actions">
              <button
                className="tourney-owner-button"
                type="button"
                disabled={isBusy}
                onClick={handleJoinSubstitutePool}
              >
                Join substitute pool
              </button>
              <button
                className="tourney-owner-link"
                type="button"
                disabled={isBusy}
                onClick={handleChangeRole}
              >
                Change role
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}
