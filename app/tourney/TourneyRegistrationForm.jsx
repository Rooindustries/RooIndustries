"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import SupabaseSocialLogin from "../../src/components/SupabaseSocialLogin";

const TOURNEY_SIGNUP_DRAFT = "tourney_signup_draft";

const rankOptions = [
  "Master",
  "Grandmaster",
  "Champion",
];

const roleOptions = ["Tank", "Damage", "Support", "Flex"];
const supportRole = "Support";
const supportWarningTitleId = "support-role-warning-title";
const supportWarningDescriptionId = "support-role-warning-description";

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
  secondaryRolePlay: "",
  timezone: "",
  twitchUsername: "",
  availableAug12: false,
  acceptedRules: false,
  acceptedCreatorEligibility: false,
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
  const [isHydrated, setIsHydrated] = useState(false);
  const [supportWarning, setSupportWarning] = useState(null);
  const [supportWarningAccepted, setSupportWarningAccepted] = useState(false);
  const [socialIdentity, setSocialIdentity] = useState(null);
  const primaryRoleRef = useRef(null);
  const secondaryRoleRef = useRef(null);
  const supportApplyRef = useRef(null);

  useEffect(() => {
    try {
      const draft = JSON.parse(sessionStorage.getItem(TOURNEY_SIGNUP_DRAFT) || "null");
      if (draft && typeof draft === "object") {
        setForm((current) => ({ ...current, ...draft, password: "", passwordConfirm: "" }));
      }
    } catch {
      sessionStorage.removeItem(TOURNEY_SIGNUP_DRAFT);
    }
    fetch("/api/auth/identities?flow=tourney", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (data?.authenticated && data?.emailVerified && data.email) {
          setForm((current) => ({ ...current, email: data.email }));
          setSocialIdentity(data);
        }
      })
      .catch(() => {});
    setIsHydrated(true);
  }, []);

  const saveDraft = () => {
    const { password: _password, passwordConfirm: _confirm, ...safeDraft } = form;
    sessionStorage.setItem(TOURNEY_SIGNUP_DRAFT, JSON.stringify(safeDraft));
  };

  useEffect(() => {
    if (supportWarning) {
      supportApplyRef.current?.focus();
    }
  }, [supportWarning]);

  const hasSupportSelection = (values = form) =>
    values.rolePlay === supportRole || values.secondaryRolePlay === supportRole;

  const resetSupportAcknowledgementIfNeeded = (values) => {
    if (!hasSupportSelection(values)) {
      setSupportWarningAccepted(false);
    }
  };

  const openSupportWarning = (field, submitAfterApply = false) => {
    setSupportWarning({ field, submitAfterApply });
  };

  const updateField = (field, value) => {
    const nextForm = { ...form, [field]: value };
    setForm(nextForm);
    resetSupportAcknowledgementIfNeeded(nextForm);
  };

  const updatePrimaryRole = (nextRole) => {
    const nextForm = {
      ...form,
      rolePlay: nextRole,
      secondaryRolePlay:
        form.secondaryRolePlay === nextRole ? "" : form.secondaryRolePlay,
    };

    setForm(nextForm);

    if (nextRole === supportRole) {
      setSupportWarningAccepted(false);
      openSupportWarning("rolePlay");
      return;
    }

    resetSupportAcknowledgementIfNeeded(nextForm);
  };

  const updateSecondaryRole = (nextRole) => {
    const nextForm = { ...form, secondaryRolePlay: nextRole };

    setForm(nextForm);

    if (nextRole === supportRole) {
      setSupportWarningAccepted(false);
      openSupportWarning("secondaryRolePlay");
      return;
    }

    resetSupportAcknowledgementIfNeeded(nextForm);
  };

  const submitRegistration = async () => {
    setIsBusy(true);
    setMessage("");
    setIsSuccess(false);

    try {
      if (!socialIdentity && form.password !== form.passwordConfirm) {
        throw new Error("Passwords must match.");
      }
      if (form.secondaryRolePlay && form.secondaryRolePlay === form.rolePlay) {
        throw new Error("Secondary role must be different from primary role.");
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
      sessionStorage.removeItem(TOURNEY_SIGNUP_DRAFT);
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

    if (hasSupportSelection() && !supportWarningAccepted) {
      openSupportWarning(
        form.rolePlay === supportRole ? "rolePlay" : "secondaryRolePlay",
        true
      );
      return;
    }

    await submitRegistration();
  };

  const handleApplyAnyway = async () => {
    const shouldSubmit = Boolean(supportWarning?.submitAfterApply);

    setSupportWarningAccepted(true);
    setSupportWarning(null);

    if (shouldSubmit) {
      await submitRegistration();
    }
  };

  const handleChangeRole = () => {
    const field = supportWarning?.field || "rolePlay";

    setSupportWarning(null);
    setSupportWarningAccepted(false);
    setForm((current) => {
      if (field === "secondaryRolePlay") {
        return { ...current, secondaryRolePlay: "" };
      }

      return {
        ...current,
        rolePlay: "",
        secondaryRolePlay:
          current.secondaryRolePlay === supportRole ? "" : current.secondaryRolePlay,
      };
    });

    window.setTimeout(() => {
      if (field === "secondaryRolePlay") {
        secondaryRoleRef.current?.focus();
        return;
      }

      primaryRoleRef.current?.focus();
    }, 0);
  };

  if (registrationClosed) {
    return (
      <div className="tourney-status-panel">
        <p className="tourney-kicker">Closed</p>
        <h3>Creator registration is closed</h3>
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

  const supportWarningDialog = supportWarning ? (
    <div className="tourney-modal-backdrop">
      <div
        aria-describedby={supportWarningDescriptionId}
        aria-labelledby={supportWarningTitleId}
        aria-modal="true"
        className="tourney-modal"
        role="dialog"
      >
        <p className="tourney-kicker">Role Warning</p>
        <h3 id={supportWarningTitleId}>Support signups are crowded</h3>
        <p id={supportWarningDescriptionId}>
          A lot of support players are signing up, so your chances of being
          accepted as Support may be lower. Choose a different role for a
          higher chance of being selected.
        </p>
        <div className="tourney-modal-actions">
          <button
            className="tourney-owner-button"
            onClick={handleApplyAnyway}
            ref={supportApplyRef}
            type="button"
          >
            Apply anyway
          </button>
          <button
            className="tourney-owner-link"
            onClick={handleChangeRole}
            type="button"
          >
            Change role
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <form className="tourney-form" onSubmit={handleSubmit}>
      <p className="tourney-form-note">
        Creator registration closes{" "}
        <time dateTime={registrationClosesAt}>July 22, 2026 at 00:00 UTC</time>.
        Your Twitch username is required for eligibility review. Drafts happen
        July 25, 2026 at a TBD time.
      </p>
      <SupabaseSocialLogin
        action="signup"
        flow="tourney"
        nextPath="/tourney/register"
        onBeforeRedirect={saveDraft}
        variant="tourney"
      />
      {socialIdentity ? (
        <p className="tourney-form-message is-success">
          Verified as {socialIdentity.email}. You can use Google or Discord to sign in.
        </p>
      ) : null}
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
            readOnly={Boolean(socialIdentity)}
          />
        </label>
        {!socialIdentity ? <label>
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
        </label> : null}
        {!socialIdentity ? <label>
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
        </label> : null}
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
            ref={primaryRoleRef}
            required
            value={form.rolePlay}
            onChange={(event) => updatePrimaryRole(event.target.value)}
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
          Secondary Role
          <select
            {...hydrationSafeControlProps}
            name="secondaryRolePlay"
            ref={secondaryRoleRef}
            value={form.secondaryRolePlay}
            onChange={(event) => updateSecondaryRole(event.target.value)}
          >
            <option value="">No secondary role</option>
            {roleOptions.map((role) => (
              <option
                disabled={role === form.rolePlay}
                key={role}
                value={role}
              >
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
          name="acceptedCreatorEligibility"
          type="checkbox"
          required
          checked={form.acceptedCreatorEligibility}
          onChange={(event) =>
            updateField("acceptedCreatorEligibility", event.target.checked)
          }
        />
        <span>
          I understand this is a creator tournament and my Twitch username
          will be used for eligibility review.
        </span>
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

      </form>
      {supportWarningDialog && typeof document !== "undefined"
        ? createPortal(supportWarningDialog, document.body)
        : null}
    </>
  );
}
