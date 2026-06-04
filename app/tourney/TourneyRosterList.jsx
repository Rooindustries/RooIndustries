"use client";

import { useMemo, useState } from "react";

const sortOptions = [
  { key: "name", label: "Name" },
  { key: "role", label: "Role" },
  { key: "twitch", label: "Twitch" },
  { key: "team", label: "Team" },
];

const normalizeSortValue = (value) => String(value || "").trim().toLowerCase();
const twitchLoginPattern = /^[a-z0-9_]{3,25}$/;

const getTeamLabel = (teamName) => String(teamName || "").trim() || "TBD";

const getTwitchButtonLabel = (player) => {
  const displayName = normalizeSortValue(player?.displayName);
  const twitchUsername = normalizeSortValue(player?.twitchUsername);
  if (displayName === "val" && twitchUsername === "vaieia") {
    return "valeia";
  }
  return String(player?.twitchUsername || "").trim();
};

const compareText = (left, right) =>
  normalizeSortValue(left).localeCompare(normalizeSortValue(right));

const compareByName = (left, right) =>
  compareText(left.displayName || "Player", right.displayName || "Player");

const compareByTeam = (left, right) => {
  const leftTeam = normalizeSortValue(left.teamName);
  const rightTeam = normalizeSortValue(right.teamName);
  if (!leftTeam && rightTeam) return 1;
  if (leftTeam && !rightTeam) return -1;
  const teamCompare = leftTeam.localeCompare(rightTeam);
  return teamCompare || compareByName(left, right);
};

const sortPlayers = (players, sortKey) =>
  [...players].sort((left, right) => {
    if (sortKey === "role") {
      return compareText(left.rolePlay, right.rolePlay) || compareByName(left, right);
    }
    if (sortKey === "twitch") {
      return (
        compareText(getTwitchButtonLabel(left), getTwitchButtonLabel(right)) ||
        compareByName(left, right)
      );
    }
    if (sortKey === "team") {
      return compareByTeam(left, right);
    }
    return compareByName(left, right);
  });

const twitchUrl = (username) => {
  const login = normalizeSortValue(username);
  return twitchLoginPattern.test(login) ? `https://www.twitch.tv/${login}` : "";
};

const TwitchIcon = () => (
  <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
    <path
      d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"
      fill="currentColor"
    />
  </svg>
);

export default function TourneyRosterList({ players = [] }) {
  const [sortKey, setSortKey] = useState("name");
  const sortedPlayers = useMemo(() => sortPlayers(players, sortKey), [
    players,
    sortKey,
  ]);

  return (
    <>
      <div className="tourney-roster-controls" aria-label="Roster sorting">
        {sortOptions.map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={sortKey === option.key}
            className={sortKey === option.key ? "is-active" : ""}
            onClick={() => setSortKey(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <ul className="tourney-roster-list">
        {sortedPlayers.map((player) => {
          const teamLabel = getTeamLabel(player.teamName);
          const streamUrl = twitchUrl(player.twitchUsername);
          const twitchLabel = getTwitchButtonLabel(player);

          return (
            <li className="tourney-roster-player" key={player.id}>
              <span className="tourney-roster-identity">
                <strong>{player.displayName || "Player"}</strong>
                <span>Player</span>
              </span>
              <span>
                <strong>{player.rolePlay}</strong>
                <span>Primary role</span>
              </span>
              <span>
                <strong>{teamLabel}</strong>
                <span>Team</span>
              </span>
              <span className="tourney-roster-cta">
                {streamUrl ? (
                  <a href={streamUrl} rel="noreferrer" target="_blank">
                    <TwitchIcon />
                    <span>{twitchLabel}</span>
                  </a>
                ) : (
                  <span className="tourney-roster-no-stream">No Twitch</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
