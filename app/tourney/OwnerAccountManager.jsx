"use client";

import { useMemo, useState } from "react";

const managedRoles = ["caster", "viewer"];

const accountStatusLabel = (account) => (account.active ? "Active" : "Disabled");

export default function OwnerAccountManager({
  initialAccounts = [],
  currentUsername = "",
}) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [accountsJson, setAccountsJson] = useState("");
  const [message, setMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [passwordDrafts, setPasswordDrafts] = useState({});

  const sortedAccounts = useMemo(
    () => [...accounts].sort((left, right) => left.username.localeCompare(right.username)),
    [accounts]
  );

  const updateAccounts = async (payload) => {
    setIsBusy(true);
    setMessage("");

    try {
      const response = await fetch("/api/tourney/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || "Unable to update account.");
      }

      setAccounts(data.accounts || []);
      setAccountsJson(data.persisted ? "" : data.accountsJson || "");
      setMessage(
        data.persisted
          ? "Saved. Account changes are live now."
          : "Updated JSON is ready for TOURNEY_ACCOUNTS_JSON."
      );
      return true;
    } catch (error) {
      setMessage(error?.message || "Unable to update account.");
      return false;
    } finally {
      setIsBusy(false);
    }
  };

  const handleUpsert = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const didUpdate = await updateAccounts({
      action: "upsert",
      username: formData.get("username"),
      email: formData.get("email"),
      role: formData.get("role"),
      password: formData.get("password"),
    });

    if (didUpdate) {
      form.reset();
    }
  };

  const handleDisable = async (username) => {
    await updateAccounts({
      action: "disable",
      username,
    });
  };

  const handlePasswordDraft = (username, value) => {
    setPasswordDrafts((current) => ({
      ...current,
      [username]: value,
    }));
  };

  const handlePasswordChange = async (event, username) => {
    event.preventDefault();
    const password = passwordDrafts[username] || "";
    const didUpdate = await updateAccounts({
      action: "change-password",
      username,
      password,
    });

    if (didUpdate) {
      setPasswordDrafts((current) => ({
        ...current,
        [username]: "",
      }));
    }
  };

  return (
    <div className="tourney-owner-manager">
      <div className="tourney-owner-layout">
        <form className="tourney-owner-form" onSubmit={handleUpsert}>
          <label>
            Username
            <input
              name="username"
              type="text"
              autoComplete="off"
              required
              placeholder="caster-name"
            />
          </label>
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="email"
              placeholder="caster@example.com"
            />
          </label>
          <label>
            Role
            <select name="role" defaultValue="caster" required>
              {managedRoles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              placeholder="8+ characters"
            />
          </label>
          <button className="tourney-owner-button" type="submit" disabled={isBusy}>
            {isBusy ? "Working..." : "Create or update"}
          </button>
        </form>

        <div className="tourney-owner-table" aria-label="Tournament accounts">
          {sortedAccounts.map((account) => (
            <div className="tourney-owner-row" key={account.username}>
              <span>
                <strong>{account.username}</strong>
                <small>
                  {account.role}
                  {account.email ? ` - ${account.email}` : ""}
                </small>
              </span>
              <span className={account.active ? "is-active" : "is-disabled"}>
                {accountStatusLabel(account)}
              </span>
              <span>v{account.version}</span>
              {account.role === "owner" && account.username !== currentUsername ? (
                <span className="tourney-owner-locked">Server env</span>
              ) : (
                <div className="tourney-owner-actions">
                  <form onSubmit={(event) => handlePasswordChange(event, account.username)}>
                    <input
                      aria-label={`New password for ${account.username}`}
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      placeholder="New password"
                      value={passwordDrafts[account.username] || ""}
                      onChange={(event) =>
                        handlePasswordDraft(account.username, event.target.value)
                      }
                      required
                    />
                    <button
                      className="tourney-owner-link"
                      type="submit"
                      disabled={isBusy || !account.active}
                    >
                      Change
                    </button>
                  </form>
                  <button
                    className="tourney-owner-link is-danger"
                    type="button"
                    disabled={isBusy || !account.active || account.role === "owner"}
                    onClick={() => handleDisable(account.username)}
                  >
                    {account.role === "owner" ? "Protected" : "Disable"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {message ? <p className="tourney-owner-message">{message}</p> : null}
      {accountsJson ? (
        <label className="tourney-owner-json">
          TOURNEY_ACCOUNTS_JSON
          <textarea readOnly value={accountsJson} />
        </label>
      ) : null}
    </div>
  );
}
