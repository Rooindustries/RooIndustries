"use client";

import { useState } from "react";
import { tourneyMutationFetch } from "./tourneyMutation";

const emptyAppeal = {
  type: "team-appeal",
  title: "",
  teamName: "",
  captainName: "",
  subjectName: "",
  evidenceUrl: "",
  details: "",
};

const statusOptions = ["open", "reviewing", "upheld", "denied", "closed"];

const typeLabel = (type) =>
  type === "captain-complaint" ? "Captain complaint" : "Team appeal";

export default function TourneyAppealsPanel({
  initialAppeals = [],
  currentRole = "player",
}) {
  const [appeals, setAppeals] = useState(initialAppeals);
  const [form, setForm] = useState(emptyAppeal);
  const [message, setMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const isAdmin = currentRole === "owner" || currentRole === "caster";

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const postAppeals = async (payload) => {
    setIsBusy(true);
    setMessage("");
    try {
      const response = await tourneyMutationFetch("/api/tourney/appeals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || "Unable to update appeals.");
      }
      setAppeals(data.appeals || []);
      setMessage("Appeals updated.");
      return true;
    } catch (error) {
      setMessage(error?.message || "Unable to update appeals.");
      return false;
    } finally {
      setIsBusy(false);
    }
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    const didCreate = await postAppeals({ ...form, action: "create" });
    if (didCreate) setForm(emptyAppeal);
  };

  const handleUpdate = async (event, appealId) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    await postAppeals({
      action: "update",
      appealId,
      status: formData.get("status"),
      ruling: formData.get("ruling"),
    });
  };

  return (
    <div className="tourney-record-panel">
      <form className="tourney-owner-form" onSubmit={handleCreate}>
        <label>
          Appeal Type
          <select
            value={form.type}
            onChange={(event) => updateField("type", event.target.value)}
          >
            <option value="team-appeal">Team appeal</option>
            <option value="captain-complaint">Captain complaint</option>
          </select>
        </label>
        <label>
          Title
          <input
            type="text"
            minLength={3}
            required
            value={form.title}
            onChange={(event) => updateField("title", event.target.value)}
          />
        </label>
        <div className="tourney-form-grid">
          <label>
            Team
            <input
              type="text"
              value={form.teamName}
              onChange={(event) => updateField("teamName", event.target.value)}
            />
          </label>
          <label>
            Captain
            <input
              type="text"
              value={form.captainName}
              onChange={(event) => updateField("captainName", event.target.value)}
            />
          </label>
        </div>
        <label>
          Player / Captain Involved
          <input
            type="text"
            value={form.subjectName}
            onChange={(event) => updateField("subjectName", event.target.value)}
          />
        </label>
        <label>
          Evidence Link
          <input
            type="url"
            value={form.evidenceUrl}
            onChange={(event) => updateField("evidenceUrl", event.target.value)}
          />
        </label>
        <label>
          Details
          <textarea
            rows={5}
            required
            value={form.details}
            onChange={(event) => updateField("details", event.target.value)}
          />
        </label>
        <button className="tourney-owner-button" type="submit" disabled={isBusy}>
          Submit appeal
        </button>
      </form>

      {message ? <p className="tourney-form-message">{message}</p> : null}

      <div className="tourney-record-list">
        {appeals.length === 0 ? (
          <p className="tourney-empty">No appeals yet.</p>
        ) : (
          appeals.map((appeal) => (
            <article className="tourney-record-row" key={appeal.id}>
              <div>
                <p className="tourney-kicker">{typeLabel(appeal.type)}</p>
                <h3>{appeal.title}</h3>
                <p>{appeal.details}</p>
                <small>
                  {appeal.teamName || "No team"} - {appeal.status}
                  {appeal.captainName ? ` - Captain: ${appeal.captainName}` : ""}
                </small>
                {appeal.evidenceUrl ? (
                  <a href={appeal.evidenceUrl} rel="noopener noreferrer" target="_blank">
                    Evidence
                  </a>
                ) : null}
                {appeal.ruling ? <p>Ruling: {appeal.ruling}</p> : null}
              </div>
              {isAdmin ? (
                <form
                  className="tourney-inline-form"
                  onSubmit={(event) => handleUpdate(event, appeal.id)}
                >
                  <label>
                    Status
                    <select name="status" defaultValue={appeal.status}>
                      {statusOptions.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Ruling
                    <input name="ruling" type="text" defaultValue={appeal.ruling} />
                  </label>
                  <button className="tourney-owner-link" type="submit" disabled={isBusy}>
                    Save
                  </button>
                </form>
              ) : null}
            </article>
          ))
        )}
      </div>
    </div>
  );
}
