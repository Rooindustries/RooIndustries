"use client";

import { useState } from "react";

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
  notes: "",
};

export default function TourneyRegistrationForm() {
  const [form, setForm] = useState(initialForm);
  const [message, setMessage] = useState("");
  const [isSuccess, setIsSuccess] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
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
        body: JSON.stringify(form),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || "Unable to submit registration.");
      }

      setForm(initialForm);
      setMessage(data.message || "Registration submitted.");
      setIsSuccess(true);
    } catch (error) {
      setMessage(error?.message || "Unable to submit registration.");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <form className="tourney-form" onSubmit={handleSubmit}>
      <div className="tourney-form-grid">
        <label>
          Discord Username
          <input
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
          type="checkbox"
          required
          checked={form.availableAug12}
          onChange={(event) => updateField("availableAug12", event.target.checked)}
        />
        <span>Are you free on August 1st and 2nd?</span>
      </label>

      <label>
        Extra notes
        <textarea
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
    </form>
  );
}
