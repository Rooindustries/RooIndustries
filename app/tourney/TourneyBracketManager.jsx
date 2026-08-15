"use client";

import { useMemo, useState } from "react";
import { canManageTourneyMatch } from "../../src/server/tourney/access";
import TourneyBracketView from "./TourneyBracketView";
import { tourneyMutationFetch, tourneyMutationSuccessMessage } from "./tourneyMutation";
import { useBracketSnapshotPoll } from "./useBracketSnapshotPoll";

const emptyTeamForm = {
  teamId: "",
  name: "",
  seed: "",
};

const getBroadcastValue = ({ broadcastForms, match, field }) => {
  const saved = broadcastForms[match.id]?.[field];
  if (saved !== undefined) return saved;
  return match.broadcast?.[field] || (field === "displayMode" ? "score" : "");
};

const getScoreValue = ({ scoreForms, match, side }) => {
  const saved = scoreForms[match.id]?.[`${side}Score`];
  if (saved !== undefined) return saved;
  return match[side]?.score === "" ? "" : match[side]?.score ?? "";
};

const activeTeams = (teams = []) =>
  teams.filter((team) => team.status !== "disqualified");

const catalogNames = (records = []) =>
  [...new Set(records.map((record) => String(record?.name || "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));

const withCurrentOption = (options, currentValue) => {
  const current = String(currentValue || "").trim();
  return current && !options.includes(current)
    ? [current, ...options]
    : options;
};

const auditTimeLabel = (value) =>
  value instanceof Date ? value.toISOString() : String(value || "");

export default function TourneyBracketManager({
  initialSnapshot,
  currentRole = "caster",
  currentUsername = "",
  broadcastMedia = { heroes: [], maps: [] },
  broadcastSourcePaths = {},
  operationsOnly = false,
}) {
  const [snapshot, setSnapshot] = useBracketSnapshotPoll(initialSnapshot);
  const [teamForm, setTeamForm] = useState(emptyTeamForm);
  const [scoreForms, setScoreForms] = useState({});
  const [broadcastForms, setBroadcastForms] = useState({});
  const [reasonForms, setReasonForms] = useState({});
  const [message, setMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const canSetup = currentRole === "owner";
  const teams = snapshot?.teams || [];
  const matches = (snapshot?.matches || []).filter((match) => !match.autoAdvance);
  const mapNames = useMemo(
    () => catalogNames(broadcastMedia.maps),
    [broadcastMedia.maps]
  );
  const heroNames = useMemo(
    () => catalogNames(broadcastMedia.heroes),
    [broadcastMedia.heroes]
  );
  const matchCounts = matches.reduce(
    (counts, match) => {
      if (match.statusLabel === "Ready") counts.ready += 1;
      if (match.statusLabel === "Running") counts.running += 1;
      if (["Completed", "Archived"].includes(match.statusLabel)) counts.completed += 1;
      return counts;
    },
    { ready: 0, running: 0, completed: 0 }
  );
  const seededTeams = useMemo(
    () =>
      [...activeTeams(teams)].sort((left, right) => {
        const leftSeed = left.seed ?? 9999;
        const rightSeed = right.seed ?? 9999;
        if (leftSeed !== rightSeed) return leftSeed - rightSeed;
        return left.name.localeCompare(right.name);
      }),
    [teams]
  );

  const updateTeamForm = (field, value) => {
    setTeamForm((current) => ({ ...current, [field]: value }));
  };

  const postBracketAction = async (payload) => {
    setIsBusy(true);
    setMessage("");
    try {
      const response = await tourneyMutationFetch("/api/tourney/bracket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || "Unable to update bracket.");
      }
      setSnapshot(data);
      setMessage(tourneyMutationSuccessMessage(data, "Bracket updated."));
      return true;
    } catch (error) {
      setMessage(error?.message || "Unable to update bracket.");
      return false;
    } finally {
      setIsBusy(false);
    }
  };

  const handleTeamSubmit = async (event) => {
    event.preventDefault();
    const didUpdate = await postBracketAction({
      action: "upsert-team",
      teamId: teamForm.teamId,
      name: teamForm.name,
      seed: teamForm.seed,
    });
    if (didUpdate) setTeamForm(emptyTeamForm);
  };

  const editTeam = (team) => {
    setTeamForm({
      teamId: team.id,
      name: team.name,
      seed: team.seed ?? "",
    });
  };

  const updateScore = (matchId, field, value) => {
    setScoreForms((current) => ({
      ...current,
      [matchId]: {
        ...(current[matchId] || {}),
        [field]: value,
      },
    }));
  };

  const updateBroadcast = (matchId, field, value) => {
    setBroadcastForms((current) => ({
      ...current,
      [matchId]: {
        ...(current[matchId] || {}),
        [field]: value,
      },
    }));
  };

  const submitBroadcast = async (event, match) => {
    event.preventDefault();
    const didUpdate = await postBracketAction({
      action: "update-broadcast",
      matchId: match.id,
      mapName: getBroadcastValue({ broadcastForms, match, field: "mapName" }),
      mapMode: getBroadcastValue({ broadcastForms, match, field: "mapMode" }),
      pickedBy: getBroadcastValue({ broadcastForms, match, field: "pickedBy" }),
      opponent1Ban: getBroadcastValue({
        broadcastForms,
        match,
        field: "opponent1Ban",
      }),
      opponent2Ban: getBroadcastValue({
        broadcastForms,
        match,
        field: "opponent2Ban",
      }),
      displayMode: getBroadcastValue({
        broadcastForms,
        match,
        field: "displayMode",
      }),
    });
    if (didUpdate) {
      setBroadcastForms((current) => {
        const next = { ...current };
        delete next[match.id];
        return next;
      });
    }
  };

  const copyBroadcastSource = async (sourcePath, theme) => {
    if (!sourcePath || typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${sourcePath}&theme=${theme}`
      );
      setMessage(`${theme === "dark" ? "Blackout" : "Roo Blue"} OBS source copied.`);
    } catch {
      setMessage("Unable to copy the OBS source.");
    }
  };

  const updateReason = (matchId, value) => {
    setReasonForms((current) => ({ ...current, [matchId]: value }));
  };

  const submitScore = (event, match) => {
    event.preventDefault();
    return postBracketAction({
      action: "score-match",
      matchId: match.id,
      opponent1Score: getScoreValue({ scoreForms, match, side: "opponent1" }),
      opponent2Score: getScoreValue({ scoreForms, match, side: "opponent2" }),
    });
  };

  const matchControls = (match) => {
    const canManage = canManageTourneyMatch({
      session: { username: currentUsername, role: currentRole },
      match,
    });
    if (!canManage) return null;

    const isReady = match.statusLabel === "Ready";
    const isRunning = match.statusLabel === "Running";
    const isOpen = ["Ready", "Running"].includes(match.statusLabel);
    const isCompleted = ["Completed", "Archived"].includes(match.statusLabel);
    const reason = reasonForms[match.id] || "";
    const sourcePath = broadcastSourcePaths[match.id] || "";

    return (
      <div className="tourney-match-controls">
        {isReady ? (
          <div className="tourney-match-actions">
            <button
              className="tourney-owner-link"
              type="button"
              disabled={isBusy}
              onClick={() =>
                postBracketAction({
                  action: "start-match",
                  matchId: match.id,
                })
              }
            >
              Start live
            </button>
          </div>
        ) : null}
        {isOpen ? (
          <>
            {isRunning ? (
              <form onSubmit={(event) => submitScore(event, match)}>
                <input
                  type="number"
                  min={0}
                  max={match.targetScore}
                  aria-label={`${match.opponent1.name} score`}
                  value={getScoreValue({ scoreForms, match, side: "opponent1" })}
                  onChange={(event) =>
                    updateScore(match.id, "opponent1Score", event.target.value)
                  }
                />
                <input
                  type="number"
                  min={0}
                  max={match.targetScore}
                  aria-label={`${match.opponent2.name} score`}
                  value={getScoreValue({ scoreForms, match, side: "opponent2" })}
                  onChange={(event) =>
                    updateScore(match.id, "opponent2Score", event.target.value)
                  }
                />
                <button className="tourney-owner-link" type="submit" disabled={isBusy}>
                  Update score
                </button>
              </form>
            ) : null}
            <input
              type="text"
              value={reason}
              placeholder="Reason"
              aria-label={`${match.displayLabel || match.label} reason`}
              onChange={(event) => updateReason(match.id, event.target.value)}
            />
            <div className="tourney-match-actions">
              {["opponent1", "opponent2"].map((side) => (
                <button
                  className="tourney-owner-link is-danger"
                  type="button"
                  disabled={isBusy || !match[side]?.teamId}
                  key={`forfeit-${side}`}
                  onClick={() =>
                    postBracketAction({
                      action: "forfeit-match",
                      matchId: match.id,
                      losingSide: side,
                      reason,
                    })
                  }
                >
                  Forfeit {side === "opponent1" ? "top" : "bottom"}
                </button>
              ))}
              {["opponent1", "opponent2"].map((side) => (
                <button
                  className="tourney-owner-link is-danger"
                  type="button"
                  disabled={isBusy || !match[side]?.teamId}
                  key={`dq-${side}`}
                  onClick={() =>
                    postBracketAction({
                      action: "disqualify-team",
                      matchId: match.id,
                      teamId: match[side].teamId,
                      reason,
                    })
                  }
                >
                  DQ {side === "opponent1" ? "top" : "bottom"}
                </button>
              ))}
            </div>
          </>
        ) : null}
        {isCompleted ? (
          <div className="tourney-match-actions">
            <button
              className="tourney-owner-link"
              type="button"
              disabled={isBusy}
              onClick={() =>
                postBracketAction({
                  action: "reopen-match",
                  matchId: match.id,
                })
              }
            >
              Reopen
            </button>
            {canSetup ? (
              <button
                className="tourney-owner-link is-danger"
                type="button"
                disabled={isBusy}
                onClick={() =>
                  postBracketAction({
                    action: "reopen-match",
                    matchId: match.id,
                    force: true,
                  })
                }
              >
                Force reopen
              </button>
            ) : null}
          </div>
        ) : null}
        <details className="tourney-broadcast-panel">
          <summary>
            <span>Broadcast overlay</span>
            <b>{match.broadcast?.displayMode || "score"}</b>
          </summary>
          <form
            className="tourney-broadcast-form"
            onSubmit={(event) => submitBroadcast(event, match)}
          >
            <label>
              Current map
              <select
                value={getBroadcastValue({ broadcastForms, match, field: "mapName" })}
                onChange={(event) =>
                  updateBroadcast(match.id, "mapName", event.target.value)
                }
              >
                <option value="">Not selected</option>
                {withCurrentOption(
                  mapNames,
                  getBroadcastValue({ broadcastForms, match, field: "mapName" })
                ).map((mapName) => (
                  <option key={mapName} value={mapName}>
                    {mapName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Map mode
              <input
                type="text"
                maxLength={32}
                placeholder="e.g. Control"
                value={getBroadcastValue({ broadcastForms, match, field: "mapMode" })}
                onChange={(event) =>
                  updateBroadcast(match.id, "mapMode", event.target.value)
                }
              />
            </label>
            <label>
              Map picked by
              <select
                value={getBroadcastValue({ broadcastForms, match, field: "pickedBy" })}
                onChange={(event) =>
                  updateBroadcast(match.id, "pickedBy", event.target.value)
                }
              >
                <option value="">Not shown</option>
                <option value="opponent1">{match.opponent1.name}</option>
                <option value="opponent2">{match.opponent2.name}</option>
              </select>
            </label>
            <label>
              Graphic
              <select
                value={getBroadcastValue({
                  broadcastForms,
                  match,
                  field: "displayMode",
                })}
                onChange={(event) =>
                  updateBroadcast(match.id, "displayMode", event.target.value)
                }
              >
                <option value="score">Score strip</option>
                <option value="bans">Map and hero bans</option>
                <option value="hidden">Hidden</option>
              </select>
            </label>
            <label>
              {match.opponent1.name} ban
              <select
                value={getBroadcastValue({
                  broadcastForms,
                  match,
                  field: "opponent1Ban",
                })}
                onChange={(event) =>
                  updateBroadcast(match.id, "opponent1Ban", event.target.value)
                }
              >
                <option value="">No hero banned</option>
                {withCurrentOption(
                  heroNames,
                  getBroadcastValue({
                    broadcastForms,
                    match,
                    field: "opponent1Ban",
                  })
                ).map((heroName) => (
                  <option key={heroName} value={heroName}>
                    {heroName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {match.opponent2.name} ban
              <select
                value={getBroadcastValue({
                  broadcastForms,
                  match,
                  field: "opponent2Ban",
                })}
                onChange={(event) =>
                  updateBroadcast(match.id, "opponent2Ban", event.target.value)
                }
              >
                <option value="">No hero banned</option>
                {withCurrentOption(
                  heroNames,
                  getBroadcastValue({
                    broadcastForms,
                    match,
                    field: "opponent2Ban",
                  })
                ).map((heroName) => (
                  <option key={heroName} value={heroName}>
                    {heroName}
                  </option>
                ))}
              </select>
            </label>
            <div className="tourney-broadcast-actions">
              <button className="tourney-owner-link" type="submit" disabled={isBusy}>
                Save broadcast
              </button>
              <button
                className="tourney-owner-link"
                type="button"
                disabled={!sourcePath}
                onClick={() => copyBroadcastSource(sourcePath, "default")}
              >
                Copy Roo Blue
              </button>
              <button
                className="tourney-owner-link"
                type="button"
                disabled={!sourcePath}
                onClick={() => copyBroadcastSource(sourcePath, "dark")}
              >
                Copy Blackout
              </button>
              {sourcePath ? (
                <>
                  <a
                    className="tourney-owner-link"
                    href={sourcePath}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open source
                  </a>
                  <a
                    className="tourney-owner-link"
                    href={`${sourcePath}&demo=1`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Demo layout
                  </a>
                </>
              ) : null}
            </div>
          </form>
        </details>
      </div>
    );
  };

  return (
    <div className="tourney-bracket-manager">
      {canSetup && !operationsOnly ? (
        <div className="tourney-bracket-admin-grid">
          <form className="tourney-form" onSubmit={handleTeamSubmit}>
            <p className="tourney-kicker">Teams</p>
            <div className="tourney-form-grid">
              <label>
                Team name
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={48}
                  value={teamForm.name}
                  onChange={(event) => updateTeamForm("name", event.target.value)}
                />
              </label>
              <label>
                Seed
                <input
                  type="number"
                  min={1}
                  max={128}
                  value={teamForm.seed}
                  onChange={(event) => updateTeamForm("seed", event.target.value)}
                />
              </label>
            </div>
            <div className="tourney-bracket-actions">
              <button className="tourney-owner-button" type="submit" disabled={isBusy}>
                {teamForm.teamId ? "Update team" : "Add team"}
              </button>
              {teamForm.teamId ? (
                <button
                  className="tourney-owner-link is-danger"
                  type="button"
                  disabled={isBusy}
                  onClick={() => setTeamForm(emptyTeamForm)}
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </form>

          <div className="tourney-team-list">
            <p className="tourney-kicker">Seeded Teams</p>
            {teams.length === 0 ? (
              <p className="tourney-empty">No teams yet.</p>
            ) : (
              seededTeams.map((team) => (
                <div className="tourney-team-row" key={team.id}>
                  <span>
                    <strong>{team.name}</strong>
                    <small>
                      {[
                        team.seed ? `Seed ${team.seed}` : "Unseeded",
                        team.memberCount ? `${team.memberCount} players` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </span>
                  <div className="tourney-team-actions">
                    <button
                      className="tourney-owner-link"
                      type="button"
                      disabled={isBusy}
                      onClick={() => editTeam(team)}
                    >
                      Edit
                    </button>
                    <button
                      className="tourney-owner-link is-danger"
                      type="button"
                      disabled={isBusy || snapshot?.generated}
                      onClick={() =>
                        postBracketAction({
                          action: "delete-team",
                          teamId: team.id,
                        })
                      }
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}

      <div className="tourney-bracket-toolbar">
        <span>
          <strong>
            {operationsOnly
              ? "Live match desk"
              : snapshot?.generated
                ? "Live bracket"
                : "Draft bracket"}
          </strong>
          <small>
            {operationsOnly
              ? `${matchCounts.running} live · ${matchCounts.ready} ready · ${matchCounts.completed} completed`
              : canSetup
                ? "Owner controls setup and reset."
                : "Casters can score, forfeit, DQ, and safe-reopen matches."}
          </small>
        </span>
        {operationsOnly ? (
          <div className="tourney-bracket-actions is-control-links">
            <a className="tourney-owner-link" href="/tourney/bracket">
              Public bracket
            </a>
            <a className="tourney-owner-link" href="/tourney/overlay">
              Stream overlays
            </a>
          </div>
        ) : canSetup ? (
          <div className="tourney-bracket-actions">
            <button
              className="tourney-owner-button"
              type="button"
              disabled={isBusy || activeTeams(teams).length < 2}
              onClick={() => postBracketAction({ action: "generate" })}
            >
              Generate bracket
            </button>
            <button
              className="tourney-owner-link is-danger"
              type="button"
              disabled={isBusy || !snapshot?.generated}
              onClick={() => postBracketAction({ action: "reset-bracket" })}
            >
              Reset bracket
            </button>
          </div>
        ) : null}
      </div>

      {operationsOnly && message ? (
        <p className="tourney-owner-message" aria-live="polite">
          {message}
        </p>
      ) : null}

      <TourneyBracketView
        snapshot={snapshot}
        renderControls={matchControls}
        showSchedule
      />

      {snapshot?.teams?.some((team) => team.status === "disqualified") ? (
        <div className="tourney-team-list">
          <p className="tourney-kicker">Disqualified Teams</p>
          {snapshot.teams
            .filter((team) => team.status === "disqualified")
            .map((team) => (
              <div className="tourney-team-row is-removed" key={team.id}>
                <span>
                  <strong>{team.name}</strong>
                  <small>Disqualified</small>
                </span>
              </div>
            ))}
        </div>
      ) : null}

      {!operationsOnly && snapshot?.audit?.length > 0 ? (
        <details className="tourney-bracket-audit" open={!operationsOnly}>
          <summary className="tourney-kicker">
            Recent Bracket Activity ({snapshot.audit.length})
          </summary>
          {snapshot.audit.map((event) => (
            <div className="tourney-audit-row" key={event.id}>
              <strong>{event.action}</strong>
              <span>{event.actorUsername}</span>
              <small>{event.reason || auditTimeLabel(event.createdAt)}</small>
            </div>
          ))}
        </details>
      ) : null}

      {!operationsOnly && message ? (
        <p className="tourney-owner-message" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}
