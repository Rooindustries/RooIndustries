"use client";

import { useMemo, useState } from "react";

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

const emptyAddForm = {
  email: "",
  password: "",
  passwordConfirm: "",
  discord: "",
  displayName: "",
  battlenet: "",
  rank: "",
  rolePlay: "",
  secondaryRolePlay: "",
  registrationPool: "main",
  timezone: "",
  twitchUsername: "",
  teamName: "",
  availableAug12: false,
  notes: "",
};

const emptyEditForm = {
  displayName: "",
  twitchUsername: "",
  teamName: "",
  registrationPool: "main",
};

const defaultCapacity = {
  teamCount: 8,
  roles: roleOptions.map((role) => ({
    role,
    cap: 16,
    mainCount: 0,
    substituteCount: 0,
    pendingMainCount: 0,
    approvedMainCount: 0,
    isFull: false,
  })),
};

const statusOrder = {
  pending: 0,
  approved: 1,
  denied: 2,
  withdrawn: 3,
  removed: 4,
};

const statusLabel = (status) => {
  if (status === "withdrawn") return "Opted out";
  if (status === "removed") return "Kicked";
  return status || "unknown";
};

const poolLabel = (pool) =>
  pool === "substitute" ? "Substitute pool" : "Main pool";

const getApprovalRoleOptions = (player = {}) =>
  [
    ...new Set([
      player.primaryRolePlay || player.rolePlay,
      player.secondaryRolePlay,
    ]),
  ].filter(Boolean);

export default function TourneyPlayerManager({
  initialPlayers = [],
  initialCapacity = defaultCapacity,
}) {
  const [players, setPlayers] = useState(initialPlayers);
  const [capacity, setCapacity] = useState(initialCapacity || defaultCapacity);
  const [capacityForm, setCapacityForm] = useState(
    String(initialCapacity?.teamCount || 8)
  );
  const [addForm, setAddForm] = useState(emptyAddForm);
  const [editingPlayerId, setEditingPlayerId] = useState("");
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [message, setMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const groupedPlayers = useMemo(() => {
    const sorted = [...players].sort((left, right) => {
      const statusCompare =
        (statusOrder[left.status] ?? 9) - (statusOrder[right.status] ?? 9);
      if (statusCompare !== 0) return statusCompare;
      return String(left.displayName || left.discord || "").localeCompare(
        String(right.displayName || right.discord || "")
      );
    });
    return {
      currentPlayers: sorted.filter(
        (player) => !["removed", "withdrawn"].includes(player.status)
      ),
      withdrawnPlayers: sorted.filter((player) => player.status === "withdrawn"),
      removedPlayers: sorted.filter((player) => player.status === "removed"),
    };
  }, [players]);

  const updatePlayers = async (payload) => {
    setIsBusy(true);
    setMessage("");

    try {
      const response = await fetch("/api/tourney/players", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || "Unable to update players.");
      }
      setPlayers(data.players || []);
      if (data.capacity) {
        setCapacity(data.capacity);
        setCapacityForm(String(data.capacity.teamCount || 8));
      }
      setMessage("Player list updated.");
      return true;
    } catch (error) {
      setMessage(error?.message || "Unable to update players.");
      return false;
    } finally {
      setIsBusy(false);
    }
  };

  const updateAddField = (field, value) => {
    setAddForm((current) => ({ ...current, [field]: value }));
  };

  const updateEditField = (field, value) => {
    setEditForm((current) => ({ ...current, [field]: value }));
  };

  const startEdit = (player) => {
    setEditingPlayerId(player.id);
    setEditForm({
      displayName: player.displayName || player.discord || "",
      twitchUsername: player.twitchUsername || "",
      teamName: player.teamName || "",
      registrationPool: player.registrationPool || "main",
    });
  };

  const cancelEdit = () => {
    setEditingPlayerId("");
    setEditForm(emptyEditForm);
  };

  const handleAdd = async (event) => {
    event.preventDefault();
    if (addForm.password !== addForm.passwordConfirm) {
      setMessage("Passwords must match.");
      return;
    }
    const didUpdate = await updatePlayers({ ...addForm, action: "add" });
    if (didUpdate) {
      setAddForm(emptyAddForm);
    }
  };

  const handleEdit = async (event, playerId) => {
    event.preventDefault();
    const didUpdate = await updatePlayers({
      ...editForm,
      action: "update-details",
      playerId,
    });
    if (didUpdate) {
      cancelEdit();
    }
  };

  const handleCapacitySubmit = async (event) => {
    event.preventDefault();
    await updatePlayers({
      action: "update-capacity",
      teamCount: capacityForm,
    });
  };

  const renderCapacityPanel = () => {
    const roles =
      Array.isArray(capacity.roles) && capacity.roles.length > 0
        ? capacity.roles
        : defaultCapacity.roles;

    return (
      <div className="tourney-capacity-panel" aria-label="Role capacity">
        <form className="tourney-capacity-form" onSubmit={handleCapacitySubmit}>
          <span>
            <strong>Role Capacity</strong>
            <small>Only approved main-pool players count toward caps.</small>
          </span>
          <label>
            Teams
            <input
              type="number"
              min={2}
              max={64}
              required
              value={capacityForm}
              onChange={(event) => setCapacityForm(event.target.value)}
            />
          </label>
          <button className="tourney-owner-link" type="submit" disabled={isBusy}>
            Save
          </button>
        </form>
        <div className="tourney-capacity-grid">
          {roles.map((role) => (
            <span
              className={
                role.isFull ? "tourney-capacity-role is-full" : "tourney-capacity-role"
              }
              key={role.role}
            >
              <strong>{role.role}</strong>
              <small>
                {role.mainCount}/{role.cap} approved
              </small>
              {role.reservedCap ? (
                <small>
                  {role.reservedCount || 0}/{role.reservedCap} reserved for{" "}
                  {role.reservedFor}
                </small>
              ) : null}
              <small>{role.substituteCount} substitute</small>
            </span>
          ))}
        </div>
      </div>
    );
  };

  const renderPlayerRows = (playerList) =>
    playerList.map((player) => (
      <div
        className={
          player.status === "removed"
            ? "tourney-player-row is-removed"
            : "tourney-player-row"
        }
        key={player.id}
      >
        <span>
          <strong>{player.displayName || player.discord}</strong>
          <small>Discord: {player.discord}</small>
        </span>
        <span>
          <strong>{player.rolePlay}</strong>
          <small>{player.rank}</small>
          {player.secondaryRolePlay ? (
            <small>
              Primary {player.primaryRolePlay || player.rolePlay} / Secondary{" "}
              {player.secondaryRolePlay}
            </small>
          ) : null}
        </span>
        <span>
          <strong>{player.teamName || "TBD"}</strong>
          <small>Team</small>
        </span>
        <span>
          <strong>{player.twitchUsername || "No Twitch"}</strong>
          <small>{player.battlenet}</small>
        </span>
        <span>
          <strong>{statusLabel(player.status)}</strong>
          <small>
            {poolLabel(player.registrationPool)} -{" "}
            {player.availableAug12 ? "Aug 15-16 yes" : "Aug 15-16 no"}
          </small>
        </span>
        <span>
          <strong>{player.email}</strong>
          <small>{player.timezone || "Timezone not set"}</small>
        </span>
        <div className="tourney-player-actions">
          <button
            className="tourney-owner-link"
            type="button"
            disabled={isBusy}
            onClick={() => startEdit(player)}
          >
            Edit
          </button>
          {player.status === "pending" ? (
            <>
              {getApprovalRoleOptions(player).map((role) => (
                <button
                  className="tourney-owner-link"
                  type="button"
                  disabled={isBusy}
                  key={role}
                  onClick={() =>
                    updatePlayers({
                      action: "approve",
                      playerId: player.id,
                      approvedRolePlay: role,
                    })
                  }
                >
                  Accept as {role}
                </button>
              ))}
              <button
                className="tourney-owner-link is-danger"
                type="button"
                disabled={isBusy}
                onClick={() => updatePlayers({ action: "deny", playerId: player.id })}
              >
                Deny
              </button>
            </>
          ) : null}
          {player.status === "approved" ? (
            <button
              className="tourney-owner-link is-danger"
              type="button"
              disabled={isBusy}
              onClick={() => updatePlayers({ action: "kick", playerId: player.id })}
            >
              Kick
            </button>
          ) : null}
        </div>
        {editingPlayerId === player.id ? (
          <form
            className="tourney-player-edit"
            onSubmit={(event) => handleEdit(event, player.id)}
          >
            <label>
              Display Name
              <input
                type="text"
                minLength={2}
                required
                value={editForm.displayName}
                onChange={(event) =>
                  updateEditField("displayName", event.target.value)
                }
              />
            </label>
            <label>
              Team
              <input
                type="text"
                value={editForm.teamName}
                onChange={(event) => updateEditField("teamName", event.target.value)}
              />
            </label>
            <label>
              Twitch Username
              <span className="tourney-prefixed-input">
                <span aria-hidden="true">twitch.tv/</span>
                <input
                  type="text"
                  maxLength={25}
                  minLength={3}
                  pattern="[A-Za-z0-9_]{3,25}"
                  required
                  value={editForm.twitchUsername}
                  onChange={(event) =>
                    updateEditField("twitchUsername", event.target.value)
                  }
                />
              </span>
            </label>
            <label>
              Player Pool
              <select
                value={editForm.registrationPool}
                onChange={(event) =>
                  updateEditField("registrationPool", event.target.value)
                }
              >
                <option value="main">Main pool</option>
                <option value="substitute">Substitute pool</option>
              </select>
            </label>
            <div className="tourney-player-edit-actions">
              <button className="tourney-owner-link" type="submit" disabled={isBusy}>
                Save
              </button>
              <button
                className="tourney-owner-link is-danger"
                type="button"
                disabled={isBusy}
                onClick={cancelEdit}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}
        {player.notes ? <p className="tourney-player-notes">{player.notes}</p> : null}
      </div>
    ));

  return (
    <div className="tourney-player-manager">
      {renderCapacityPanel()}
      <div className="tourney-player-layout">
        <form className="tourney-form" onSubmit={handleAdd}>
          <p className="tourney-kicker">Add Player</p>
          <div className="tourney-form-grid">
            <label>
              Discord Username
              <input
                type="text"
                required
                minLength={3}
                value={addForm.discord}
                onChange={(event) => updateAddField("discord", event.target.value)}
              />
            </label>
            <label>
              Display Name
              <input
                type="text"
                required
                minLength={2}
                value={addForm.displayName}
                onChange={(event) =>
                  updateAddField("displayName", event.target.value)
                }
              />
            </label>
            <label>
              Email
              <input
                type="email"
                required
                value={addForm.email}
                onChange={(event) => updateAddField("email", event.target.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                required
                minLength={8}
                value={addForm.password}
                onChange={(event) => updateAddField("password", event.target.value)}
              />
            </label>
            <label>
              Confirm password
              <input
                type="password"
                required
                minLength={8}
                value={addForm.passwordConfirm}
                onChange={(event) =>
                  updateAddField("passwordConfirm", event.target.value)
                }
              />
            </label>
            <label>
              Battle.net BattleTag
              <input
                type="text"
                required
                value={addForm.battlenet}
                onChange={(event) => updateAddField("battlenet", event.target.value)}
              />
            </label>
            <label>
              Current Overwatch rank
              <select
                required
                value={addForm.rank}
                onChange={(event) => updateAddField("rank", event.target.value)}
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
                value={addForm.rolePlay}
                onChange={(event) => {
                  const nextRole = event.target.value;
                  setAddForm((current) => ({
                    ...current,
                    rolePlay: nextRole,
                    secondaryRolePlay:
                      current.secondaryRolePlay === nextRole
                        ? ""
                        : current.secondaryRolePlay,
                  }));
                }}
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
                value={addForm.secondaryRolePlay}
                onChange={(event) =>
                  updateAddField("secondaryRolePlay", event.target.value)
                }
              >
                <option value="">No secondary role</option>
                {roleOptions.map((role) => (
                  <option
                    disabled={role === addForm.rolePlay}
                    key={role}
                    value={role}
                  >
                    {role}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Player Pool
              <select
                required
                value={addForm.registrationPool}
                onChange={(event) =>
                  updateAddField("registrationPool", event.target.value)
                }
              >
                <option value="main">Main pool</option>
                <option value="substitute">Substitute pool</option>
              </select>
            </label>
            <label>
              Timezone
              <select
                required
                value={addForm.timezone}
                onChange={(event) => updateAddField("timezone", event.target.value)}
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
                  maxLength={25}
                  minLength={3}
                  pattern="[A-Za-z0-9_]{3,25}"
                  placeholder="skinz_ow"
                  required
                  value={addForm.twitchUsername}
                  onChange={(event) =>
                    updateAddField("twitchUsername", event.target.value)
                  }
                />
              </span>
            </label>
            <label>
              Team
              <input
                type="text"
                value={addForm.teamName}
                onChange={(event) => updateAddField("teamName", event.target.value)}
              />
            </label>
          </div>
          <label className="tourney-checkbox">
            <input
              type="checkbox"
              required
              checked={addForm.availableAug12}
              onChange={(event) =>
                updateAddField("availableAug12", event.target.checked)
              }
            />
            <span>Are you free on August 15th and 16th?</span>
          </label>
          <label>
            Extra notes
            <textarea
              rows={4}
              value={addForm.notes}
              onChange={(event) => updateAddField("notes", event.target.value)}
            />
          </label>
          <button className="tourney-owner-button" type="submit" disabled={isBusy}>
            {isBusy ? "Working..." : "Add approved player"}
          </button>
        </form>

        <div className="tourney-player-table" aria-label="Tournament players">
          {players.length === 0 ? (
            <p className="tourney-empty">No registrations yet.</p>
          ) : (
            <>
              <div className="tourney-player-group">
                <p className="tourney-player-group-title">Current Players</p>
                {groupedPlayers.currentPlayers.length > 0 ? (
                  renderPlayerRows(groupedPlayers.currentPlayers)
                ) : (
                  <p className="tourney-empty">No current players.</p>
                )}
              </div>
              {groupedPlayers.removedPlayers.length > 0 ? (
                <div className="tourney-player-group">
                  <p className="tourney-player-group-title">
                    Kicked / Banned Players
                  </p>
                  {renderPlayerRows(groupedPlayers.removedPlayers)}
                </div>
              ) : null}
              {groupedPlayers.withdrawnPlayers.length > 0 ? (
                <div className="tourney-player-group">
                  <p className="tourney-player-group-title">
                    Opted Out Players
                  </p>
                  {renderPlayerRows(groupedPlayers.withdrawnPlayers)}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {message ? <p className="tourney-owner-message">{message}</p> : null}
    </div>
  );
}
