"use client";

import { useLayoutEffect, useState } from "react";
import OverlayFit from "../OverlayFit";
import { useOverlayPoll } from "../useOverlayPoll";

const DEMO_FEED = Object.freeze({
  ok: true,
  apiVersion: "1",
  version: "caster-demo",
  live: [
    {
      id: "caster-demo",
      label: "Winners Semifinal 1",
      publicMatchNumber: 17,
      status: "running",
      bestOf: 5,
      opponents: [
        { slot: 1, teamId: "demo-a", name: "TickleMonsters", score: 2 },
        { slot: 2, teamId: "demo-b", name: "Friendship is Magic", score: 1 },
      ],
      broadcast: {
        mapName: "Ilios",
        mapMode: "Control",
        pickedBy: "opponent2",
        opponent1Ban: "Ana",
        opponent2Ban: "Tracer",
        displayMode: "bans",
      },
    },
  ],
  upNext: [],
});

const pickMatch = (feed) => feed?.live?.[0] || feed?.upNext?.[0] || null;
const scoreText = (score) => (score === null || score === undefined ? "0" : score);
const mediaKey = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
const normalizeBan = (value) => String(value || "").trim();
const findMedia = (records, name) =>
  records.find((record) => mediaKey(record.name) === mediaKey(name)) || null;

const BanPlate = ({ team, hero, heroes, side }) => {
  const media = findMedia(heroes, hero);
  return (
    <div className={`ov-caster-ban is-${side}`}>
      <small>{team}</small>
      <div className="ov-caster-ban-list">
        {hero ? (
          <span className="ov-caster-ban-hero">
            {media ? <img src={media.imageUrl} alt="" /> : <i aria-hidden="true">×</i>}
            <b>{hero}</b>
          </span>
        ) : <strong>No ban</strong>}
      </div>
    </div>
  );
};

export default function CasterOverlayClient({
  initialFeed,
  matchId,
  pollSeconds,
  scale,
  theme,
  mediaCatalog,
  demo,
  demoBackground,
}) {
  const [feed, setFeed] = useState(demo ? DEMO_FEED : initialFeed);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const previousTheme = root.dataset.theme;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    const previousThemeColor = themeMeta?.getAttribute("content");
    root.dataset.theme = theme;
    themeMeta?.setAttribute("content", theme === "dark" ? "#070707" : "#000040");

    return () => {
      root.dataset.theme = previousTheme || "default";
      if (themeMeta && previousThemeColor) {
        themeMeta.setAttribute("content", previousThemeColor);
      }
    };
  }, [theme]);

  useOverlayPoll({
    url: `/api/tourney/v1/matches/live?match=${encodeURIComponent(matchId)}`,
    intervalMs: pollSeconds * 1000,
    version: feed?.version,
    onUpdate: setFeed,
    enabled: !demo,
  });

  const match = pickMatch(feed);
  const broadcast = match?.broadcast || { displayMode: "score" };
  const displayMode = broadcast.displayMode || "score";
  const [opponentA, opponentB] = match?.opponents || [];
  const heroes = mediaCatalog?.heroes || [];
  const mapMedia = findMedia(mediaCatalog?.maps || [], broadcast.mapName);
  const opponentABan = normalizeBan(broadcast.opponent1Ban);
  const opponentBBan = normalizeBan(broadcast.opponent2Ban);
  const pickedTeam = broadcast.pickedBy
    ? match?.opponents?.find((opponent) =>
        broadcast.pickedBy === "opponent1" ? opponent.slot === 1 : opponent.slot === 2
      )?.name
    : "";
  const hidden = !match || displayMode === "hidden";

  return (
    <div
      className={`tourney-page tourney-overlay ov-caster${
        demoBackground ? " ov-demo-bg" : ""
      }`}
      data-idle={hidden ? "true" : undefined}
      data-version={feed?.version || ""}
    >
      {!hidden ? (
        <OverlayFit scale={scale} inset={10}>
          <div className={`ov-caster-card is-${displayMode}`} role="status">
            <div className="ov-caster-kicker">
              <span><i /> Live series</span>
              <b>{match.publicMatchNumber ? `Match ${match.publicMatchNumber}` : match.label}</b>
              <em>Best of {match.bestOf}</em>
            </div>
            <div className="ov-caster-scoreboard">
              <div className="ov-caster-team is-a">
                <strong>{opponentA?.name || "TBD"}</strong>
                <span>{scoreText(opponentA?.score)}</span>
              </div>
              <div className="ov-caster-map">
                {mapMedia ? <img src={mapMedia.imageUrl} alt="" /> : null}
                <span aria-hidden="true" />
                <small>{broadcast.mapMode || "Current map"}</small>
                <b>{broadcast.mapName || "Map pending"}</b>
                {pickedTeam ? <em>Picked by {pickedTeam}</em> : null}
              </div>
              <div className="ov-caster-team is-b">
                <span>{scoreText(opponentB?.score)}</span>
                <strong>{opponentB?.name || "TBD"}</strong>
              </div>
            </div>
            {displayMode === "bans" ? (
              <div className="ov-caster-bans">
                <BanPlate
                  team={opponentA?.name || "Team A"}
                  hero={opponentABan}
                  heroes={heroes}
                  side="a"
                />
                <div className="ov-caster-ban-title">
                  <small>Map {Math.max(
                    Number(opponentA?.score || 0) + Number(opponentB?.score || 0) + 1,
                    1
                  )}</small>
                  <strong>Hero bans</strong>
                </div>
                <BanPlate
                  team={opponentB?.name || "Team B"}
                  hero={opponentBBan}
                  heroes={heroes}
                  side="b"
                />
              </div>
            ) : null}
          </div>
        </OverlayFit>
      ) : null}
    </div>
  );
}
