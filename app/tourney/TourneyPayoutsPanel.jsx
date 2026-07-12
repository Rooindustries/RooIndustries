"use client";

import { useState } from "react";
import { tourneyMutationFetch, tourneyMutationSuccessMessage } from "./tourneyMutation";

const emptyPayout = {
  playerId: "",
  payoutType: "placement",
  amountUsd: "",
  status: "pending",
  payoutEmail: "",
  notes: "",
};

const payoutTypes = ["placement", "mvp", "proceeds", "adjustment"];
const payoutStatuses = ["pending", "ready", "paid", "void"];

const money = (value) =>
  `$${Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export default function TourneyPayoutsPanel({
  initialPayouts = [],
  players = [],
  currentRole = "player",
}) {
  const [payouts, setPayouts] = useState(initialPayouts);
  const [form, setForm] = useState(emptyPayout);
  const [message, setMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const isAdmin = currentRole === "owner" || currentRole === "caster";

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsBusy(true);
    setMessage("");
    try {
      const response = await tourneyMutationFetch("/api/tourney/payouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || "Unable to update payouts.");
      }
      setPayouts(data.payouts || []);
      setForm(emptyPayout);
      setMessage(tourneyMutationSuccessMessage(data, "Payouts updated."));
    } catch (error) {
      setMessage(error?.message || "Unable to update payouts.");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="tourney-record-panel">
      {isAdmin ? (
        <form className="tourney-owner-form" onSubmit={handleSubmit}>
          <div className="tourney-form-grid">
            <label>
              Player
              <select
                required
                value={form.playerId}
                onChange={(event) => updateField("playerId", event.target.value)}
              >
                <option value="">Choose player</option>
                {players.map((player) => (
                  <option key={player.id} value={player.id}>
                    {player.displayName || player.discord}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Payout Type
              <select
                value={form.payoutType}
                onChange={(event) => updateField("payoutType", event.target.value)}
              >
                {payoutTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Amount USD
              <input
                type="number"
                min={0}
                step="0.01"
                required
                value={form.amountUsd}
                onChange={(event) => updateField("amountUsd", event.target.value)}
              />
            </label>
            <label>
              Status
              <select
                value={form.status}
                onChange={(event) => updateField("status", event.target.value)}
              >
                {payoutStatuses.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Payout Email
            <input
              type="email"
              value={form.payoutEmail}
              onChange={(event) => updateField("payoutEmail", event.target.value)}
            />
          </label>
          <label>
            Notes
            <textarea
              rows={4}
              value={form.notes}
              onChange={(event) => updateField("notes", event.target.value)}
            />
          </label>
          <button className="tourney-owner-button" type="submit" disabled={isBusy}>
            Save payout
          </button>
        </form>
      ) : (
        <p className="tourney-form-note">
          Payout records appear here after admins add them. Payouts are tracked
          per player.
        </p>
      )}

      {message ? <p className="tourney-form-message">{message}</p> : null}

      <div className="tourney-record-list">
        {payouts.length === 0 ? (
          <p className="tourney-empty">No payout records yet.</p>
        ) : (
          payouts.map((payout) => (
            <article className="tourney-record-row" key={payout.id}>
              <div>
                <p className="tourney-kicker">{payout.payoutType}</p>
                <h3>{payout.displayName}</h3>
                <p>
                  {money(payout.amountUsd)} - {payout.status}
                </p>
                <small>{payout.teamName || "No team"}</small>
                {payout.notes ? <p>{payout.notes}</p> : null}
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
