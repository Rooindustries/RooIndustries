"use client";

import { useMemo, useState } from "react";
import TourneyBracketView from "./TourneyBracketView";

const emptyTeamForm = {
  teamId: "",
  name: "",
  seed: "",
};

const getScoreValue = ({ scoreForms, match, side }) => {
  const saved = scoreForms[match.id]?.[`${side}Score`];
  if (saved !== undefined) return saved;
  return match[side]?.score === "" ? "" : match[side]?.score ?? "";
};

const activeTeams = (teams = []) =>
  teams.filter((team) => team.status !== "disqualified");

export default function TourneyBracketManager({
  initialSnapshot,
  currentRole = "caster",
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [teamForm, setTeamForm] = useState(emptyTeamForm);
  const [scoreForms, setScoreForms] = useState({});
  const [reasonForms, setReasonForms] = useState({});
  const [message, setMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const canSetup = currentRole === "owner";
  const teams = snapshot?.teams || [];
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
      const response = await fetch("/api/tourney/bracket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || "Unable to update bracket.");
      }
      setSnapshot(data);
      setMessage("Bracket updated.");
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
    const isOpen = ["Waiting", "Ready", "Running"].includes(match.statusLabel);
    const isCompleted = ["Completed", "Archived"].includes(match.statusLabel);
    const reason = reasonForms[match.id] || "";

    return (
      <div className="tourney-match-controls">
        {isOpen ? (
          <>
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
                Score
              </button>
            </form>
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
      </div>
    );
  };

  return (
    <div className="tourney-bracket-manager">
      {canSetup ? (
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
          <strong>{snapshot?.generated ? "Live bracket" : "Draft bracket"}</strong>
          <small>
            {canSetup
              ? "Owner controls setup and reset."
              : "Casters can score, forfeit, DQ, and safe-reopen matches."}
          </small>
        </span>
        {canSetup ? (
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

      <TourneyBracketView snapshot={snapshot} renderControls={matchControls} />

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

      {snapshot?.audit?.length > 0 ? (
        <div className="tourney-bracket-audit">
          <p className="tourney-kicker">Recent Bracket Activity</p>
          {snapshot.audit.map((event) => (
            <div className="tourney-audit-row" key={event.id}>
              <strong>{event.action}</strong>
              <span>{event.actorUsername}</span>
              <small>{event.reason || event.createdAt}</small>
            </div>
          ))}
        </div>
      ) : null}

      {message ? <p className="tourney-owner-message">{message}</p> : null}
    </div>
  );
}
