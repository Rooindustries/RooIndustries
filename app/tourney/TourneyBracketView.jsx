"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

const groupOrder = ["Winners", "Losers", "Grand Final"];
const connectorSlotHeightRem = 8.65;
const connectorSlotGapRem = 0.8;
const connectorCardGapPx = 8;
const connectorArrowSizePx = 14;
const connectorArrowHalfPx = 7;
const connectorBranchMinPx = 8;
const finalConnectorFloatGapPx = 28;

const slugClass = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// A match with exactly one real team that already holds a win result is an
// auto-advanced bye slot, not a playable pairing. Hiding it keeps odd-sized
// brackets readable; the team still appears in the round it advances to.
const isAutoAdvanceMatch = (match) => {
  const sides = [match?.opponent1, match?.opponent2];
  const filled = sides.filter((side) => side?.teamId);
  return filled.length === 1 && filled[0].result === "win";
};

const sideClass = (side) => {
  if (side.result === "win") return "is-win";
  if (side.result === "loss") return "is-loss";
  if (side.status === "disqualified") return "is-loss";
  return "";
};

const matchStatusClass = (match) => `is-${slugClass(match.statusLabel) || "unknown"}`;

const scoreText = (score) => (score === "" || score === undefined ? "-" : score);

const maxRoundMatches = (group) =>
  Math.max(...group.rounds.map((round) => round.matches.length), 1);

const groupDisplayName = (groupName) => {
  if (groupName === "Winners") return "Winners Bracket";
  if (groupName === "Losers") return "Lower Bracket";
  return groupName;
};

const roundDisplayName = ({ group, round }) => {
  const roundNumber = round?.roundNumber || 0;
  const finalRoundNumber = Math.max(
    ...group.rounds.map((candidate) => candidate.roundNumber),
    roundNumber
  );
  const roundsFromFinal = finalRoundNumber - roundNumber;

  if (group.groupName === "Winners") {
    if (roundsFromFinal === 0) return "Winners Final";
    if (roundsFromFinal === 1) return "Winners Semifinals";
    if (roundsFromFinal === 2) return "Winners Quarterfinals";
    return `Winners Round ${roundNumber}`;
  }

  if (group.groupName === "Losers") {
    if (roundsFromFinal === 0) return "Lower Final";
    if (roundsFromFinal === 1) return "Lower Semifinal";
    return `Lower Round ${roundNumber}`;
  }

  if (group.groupName === "Grand Final") return "Championship Match";
  return `Round ${roundNumber}`;
};

const groupSummaryLabel = (group) => {
  if (group.groupName === "Grand Final") return "1 match";
  return `${group.rounds.length} stages`;
};

const tbdSide = (side) => ({
  side,
  participantId: null,
  teamId: "",
  name: "TBD",
  score: "",
  result: "",
  forfeit: false,
  status: "",
});

const createTbdMatch = ({
  id,
  groupName,
  groupNumber,
  roundNumber,
  number,
  displayLabel,
  bestOf = 5,
}) => ({
  id,
  number,
  roundNumber,
  groupNumber,
  groupName,
  label: displayLabel,
  displayLabel,
  status: 0,
  statusLabel: "",
  bestOf,
  targetScore: bestOf === 7 ? 4 : 3,
  opponent1: tbdSide("opponent1"),
  opponent2: tbdSide("opponent2"),
  nextLabels: [],
});

// Skeleton shown before the bracket is generated. Mirrors the visible card
// layout of the real 12-team double-elimination bracket: 4 first-round
// winners matches with 4 bye slots hidden, and the full lower lane.
const buildTbdBracketMatches = () => [
  ...[1, 2, 3, 4].map((number) =>
    createTbdMatch({
      id: `tbd-winners-r1-${number}`,
      groupName: "Winners",
      groupNumber: 1,
      roundNumber: 1,
      number,
      displayLabel: `Winners Round 1 Match ${number}`,
    })
  ),
  ...[1, 2, 3, 4].map((number) =>
    createTbdMatch({
      id: `tbd-winners-qf-${number}`,
      groupName: "Winners",
      groupNumber: 1,
      roundNumber: 2,
      number,
      displayLabel: `Winners Quarterfinal ${number}`,
    })
  ),
  ...[1, 2].map((number) =>
    createTbdMatch({
      id: `tbd-winners-sf-${number}`,
      groupName: "Winners",
      groupNumber: 1,
      roundNumber: 3,
      number,
      displayLabel: `Winners Semifinal ${number}`,
    })
  ),
  createTbdMatch({
    id: "tbd-winners-final",
    groupName: "Winners",
    groupNumber: 1,
    roundNumber: 4,
    number: 1,
    displayLabel: "Winners Final",
  }),
  ...[1, 2, 3, 4].map((number) =>
    createTbdMatch({
      id: `tbd-lower-r1-${number}`,
      groupName: "Losers",
      groupNumber: 2,
      roundNumber: 1,
      number,
      displayLabel: `Lower Round 1 Match ${number}`,
    })
  ),
  ...[1, 2, 3, 4].map((number) =>
    createTbdMatch({
      id: `tbd-lower-r2-${number}`,
      groupName: "Losers",
      groupNumber: 2,
      roundNumber: 2,
      number,
      displayLabel: `Lower Round 2 Match ${number}`,
    })
  ),
  ...[1, 2].map((number) =>
    createTbdMatch({
      id: `tbd-lower-r3-${number}`,
      groupName: "Losers",
      groupNumber: 2,
      roundNumber: 3,
      number,
      displayLabel: `Lower Round 3 Match ${number}`,
    })
  ),
  ...[1, 2].map((number) =>
    createTbdMatch({
      id: `tbd-lower-r4-${number}`,
      groupName: "Losers",
      groupNumber: 2,
      roundNumber: 4,
      number,
      displayLabel: `Lower Round 4 Match ${number}`,
    })
  ),
  createTbdMatch({
    id: "tbd-lower-semifinal",
    groupName: "Losers",
    groupNumber: 2,
    roundNumber: 5,
    number: 1,
    displayLabel: "Lower Semifinal",
  }),
  createTbdMatch({
    id: "tbd-lower-final",
    groupName: "Losers",
    groupNumber: 2,
    roundNumber: 6,
    number: 1,
    displayLabel: "Lower Final",
  }),
  createTbdMatch({
    id: "tbd-grand-final",
    groupName: "Grand Final",
    groupNumber: 3,
    roundNumber: 1,
    number: 1,
    displayLabel: "Grand Final",
    bestOf: 7,
  }),
];

const getMatchPlacement = ({ roundSize, matchCount, index }) => {
  const slotSpan = Math.max(1, Math.floor(roundSize / Math.max(matchCount, 1)));
  return {
    "--slot-start": index * slotSpan + 1,
    "--slot-span": slotSpan,
  };
};

const groupMatches = (matches = []) =>
  groupOrder
    .map((groupName) => ({
      groupName,
      rounds: Object.values(
        matches
          .filter((match) => match.groupName === groupName)
          .reduce((acc, match) => {
            const key = String(match.roundNumber || 0);
            acc[key] = acc[key] || {
              roundNumber: match.roundNumber,
              matches: [],
            };
            acc[key].matches.push(match);
            return acc;
          }, {})
      ).sort((left, right) => left.roundNumber - right.roundNumber),
    }))
    .filter((group) => group.rounds.length > 0);

const getConnectorTargetIndex = ({ sourceIndex, sourceCount, targetCount }) => {
  if (targetCount <= 1) return 0;
  if (targetCount >= sourceCount) return Math.min(sourceIndex, targetCount - 1);
  return Math.min(Math.floor(sourceIndex / (sourceCount / targetCount)), targetCount - 1);
};

// CSS `zoom` (used by the OBS overlay to fit the frame) scales rendered
// output without changing layout sizes: getBoundingClientRect returns
// zoom-scaled px while SVG path user units stay in unscaled layout px.
// Dividing rect deltas by the tree's rendered scale converts measurements
// into path space so connectors land on the cards at any zoom level.
const getNodeCenter = ({ node, root, scale = 1 }) => {
  const nodeRect = node.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  const unit = scale > 0 && Number.isFinite(scale) ? scale : 1;

  return {
    left: (nodeRect.left - rootRect.left) / unit,
    right: (nodeRect.right - rootRect.left) / unit,
    y: (nodeRect.top - rootRect.top + nodeRect.height / 2) / unit,
  };
};

const formatPoint = (value) => value.toFixed(1);

const buildArrowPath = ({ direction = "right", x, y }) => {
  const baseX =
    direction === "left" ? x + connectorArrowSizePx : x - connectorArrowSizePx;
  return [
    `M ${formatPoint(baseX)} ${formatPoint(y)} L ${formatPoint(x)} ${formatPoint(
      y
    )}`,
    `M ${formatPoint(baseX)} ${formatPoint(
      y - connectorArrowHalfPx
    )} L ${formatPoint(x)} ${formatPoint(y)} L ${formatPoint(baseX)} ${formatPoint(
      y + connectorArrowHalfPx
    )}`,
  ].join(" ");
};

const buildGroupedConnector = ({ sources, targetX, targetY }) => {
  const primaryStartX = Math.max(...sources.map((source) => source.x));
  const arrowBaseX =
    targetX > primaryStartX
      ? targetX - connectorArrowSizePx
      : targetX + connectorArrowSizePx;
  const branchEndX = Math.max(arrowBaseX, primaryStartX + connectorBranchMinPx);
  const availableX = Math.max(0, branchEndX - primaryStartX);
  const joinX = primaryStartX + availableX * 0.5;
  const sourceYValues = sources.map((source) => source.y);
  const sourceMinY = Math.min(...sourceYValues);
  const sourceMaxY = Math.max(...sourceYValues);
  const branchY = sources.length > 1 ? (sourceMinY + sourceMaxY) / 2 : targetY;
  const minY = Math.min(sourceMinY, branchY);
  const maxY = Math.max(sourceMaxY, branchY);
  const sourceSegments = sources.map(
    (source) =>
      `M ${formatPoint(source.x)} ${formatPoint(source.y)} H ${formatPoint(joinX)}`
  );

  return {
    d: [
      ...sourceSegments,
      `M ${formatPoint(joinX)} ${formatPoint(minY)} V ${formatPoint(maxY)}`,
      `M ${formatPoint(joinX)} ${formatPoint(branchY)} H ${formatPoint(
        branchEndX
      )}`,
    ].join(" "),
    arrowD: buildArrowPath({
      x: targetX,
      y: branchY,
    }),
    branchY,
  };
};

const buildStepPath = ({ startX, startY, endX, endY, elbowX }) => {
  // Never let the elbow overshoot endX: tight finals-rail gaps would
  // otherwise draw the line past its target and double back on itself.
  const available = endX - startX;
  const step = Math.min(24, Math.max(available * 0.55, Math.min(available, 6)));
  const midX = elbowX ?? startX + step;
  return `M ${formatPoint(startX)} ${formatPoint(startY)} H ${formatPoint(
    midX
  )} V ${formatPoint(endY)} H ${formatPoint(endX)}`;
};

const getRoundKey = (groupName, roundNumber) =>
  `${slugClass(groupName)}:${roundNumber}`;

const getMatchKey = (groupName, roundNumber, matchId) =>
  `${getRoundKey(groupName, roundNumber)}:${matchId}`;

const roundPixel = (value) => Math.round(value * 10) / 10;

export default function TourneyBracketView({
  snapshot,
  renderControls,
}) {
  const { matches, byeTeams } = useMemo(() => {
    const sourceMatches = snapshot?.matches || [];
    if (!snapshot?.generated || sourceMatches.length === 0) {
      return { matches: buildTbdBracketMatches(), byeTeams: new Set() };
    }
    const byeTeams = new Set();
    const visible = sourceMatches.filter((match) => {
      if (!isAutoAdvanceMatch(match)) return true;
      const winner = [match.opponent1, match.opponent2].find(
        (side) => side?.teamId
      );
      byeTeams.add(`${match.groupName}:${winner.teamId}`);
      return false;
    });
    return { matches: visible, byeTeams };
  }, [snapshot?.generated, snapshot?.matches]);
  const grouped = useMemo(() => groupMatches(matches), [matches]);
  const firstVisibleRounds = useMemo(() => {
    const map = new Map();
    for (const group of grouped) {
      for (const round of group.rounds) {
        for (const match of round.matches) {
          for (const side of [match.opponent1, match.opponent2]) {
            if (!side?.teamId) continue;
            const key = `${group.groupName}:${side.teamId}`;
            const current = map.get(key);
            if (current === undefined || round.roundNumber < current) {
              map.set(key, round.roundNumber);
            }
          }
        }
      }
    }
    return map;
  }, [grouped]);
  const treeRef = useRef(null);
  const bandRefs = useRef(new Map());
  const matchRefs = useRef(new Map());
  const [connectors, setConnectors] = useState({ bands: {}, finals: [] });
  const [matchOffsets, setMatchOffsets] = useState({});

  const registerBand = useCallback(
    (groupName) => (node) => {
      const key = slugClass(groupName);
      if (node) bandRefs.current.set(key, node);
      else bandRefs.current.delete(key);
    },
    []
  );

  const registerMatch = useCallback(
    (groupName, roundNumber, matchId) => (node) => {
      const key = getMatchKey(groupName, roundNumber, matchId);
      if (node) matchRefs.current.set(key, node);
      else matchRefs.current.delete(key);
    },
    []
  );

  useLayoutEffect(() => {
    let frameId = 0;

    const measure = () => {
      const nextBands = {};
      const nextMatchOffsets = {};
      const treeNode = treeRef.current;
      const treeRectWidth = treeNode?.getBoundingClientRect().width || 0;
      const unitScale =
        treeRectWidth > 0 && treeNode?.offsetWidth > 0
          ? treeRectWidth / treeNode.offsetWidth
          : 1;

      for (const group of grouped) {
        const groupKey = slugClass(group.groupName);
        const bandNode = bandRefs.current.get(groupKey);
        if (!bandNode) continue;
        const connectorNode =
          bandNode.querySelector(".tourney-bracket-connectors") || bandNode;
        const baselineCenters = new Map();
        const desiredCenters = new Map();

        group.rounds.forEach((round) => {
          round.matches.forEach((match) => {
            const key = getMatchKey(group.groupName, round.roundNumber, match.id);
            const node = matchRefs.current.get(key);
            if (!node) return;

            const currentOffset = matchOffsets[key] || 0;
            const baselineCenter =
              getNodeCenter({ node, root: connectorNode, scale: unitScale }).y -
              currentOffset;
            baselineCenters.set(key, roundPixel(baselineCenter));
          });
        });

        group.rounds[0]?.matches.forEach((match) => {
          const key = getMatchKey(group.groupName, group.rounds[0].roundNumber, match.id);
          const baselineCenter = baselineCenters.get(key);
          if (baselineCenter !== undefined) desiredCenters.set(key, baselineCenter);
        });

        group.rounds.slice(1).forEach((round, roundIndex) => {
          const previousRound = group.rounds[roundIndex];
          round.matches.forEach((match, matchIndex) => {
            const sourceCenters = previousRound.matches
              .filter(
                (_, sourceIndex) =>
                  getConnectorTargetIndex({
                    sourceIndex,
                    sourceCount: previousRound.matches.length,
                    targetCount: round.matches.length,
                  }) === matchIndex
              )
              .map((sourceMatch) =>
                desiredCenters.get(
                  getMatchKey(
                    group.groupName,
                    previousRound.roundNumber,
                    sourceMatch.id
                  )
                )
              )
              .filter((center) => center !== undefined);
            const key = getMatchKey(group.groupName, round.roundNumber, match.id);
            const baselineCenter = baselineCenters.get(key);
            if (baselineCenter === undefined) return;

            const desiredCenter =
              sourceCenters.length > 0
                ? sourceCenters.reduce((sum, center) => sum + center, 0) /
                  sourceCenters.length
                : baselineCenter;
            const offset = roundPixel(desiredCenter - baselineCenter);
            desiredCenters.set(key, roundPixel(desiredCenter));
            if (Math.abs(offset) >= 0.5) nextMatchOffsets[key] = offset;
          });
        });

        const connectorGroups = new Map();
        group.rounds.forEach((round, roundIndex) => {
          const nextRound = group.rounds[roundIndex + 1];
          if (!nextRound) return;

          round.matches.forEach((match, matchIndex) => {
            const targetIndex = getConnectorTargetIndex({
              sourceIndex: matchIndex,
              sourceCount: round.matches.length,
              targetCount: nextRound.matches.length,
            });
            const targetMatch = nextRound.matches[targetIndex];
            const sourceNode = matchRefs.current.get(
              getMatchKey(group.groupName, round.roundNumber, match.id)
            );
            const targetNode = matchRefs.current.get(
              getMatchKey(group.groupName, nextRound.roundNumber, targetMatch?.id)
            );
            if (!sourceNode || !targetNode) return;

            const source = getNodeCenter({
              node: sourceNode,
              root: connectorNode,
              scale: unitScale,
            });
            const target = getNodeCenter({
              node: targetNode,
              root: connectorNode,
              scale: unitScale,
            });
            const targetKey = getMatchKey(
              group.groupName,
              nextRound.roundNumber,
              targetMatch.id
            );
            const connectorGroup = connectorGroups.get(targetKey) || {
              id: targetKey,
              sources: [],
              targetX: target.left - connectorCardGapPx,
              targetY: target.y,
            };
            connectorGroup.sources.push({
              x: source.right + connectorCardGapPx,
              y: source.y,
            });
            connectorGroups.set(targetKey, connectorGroup);
          });
        });

        nextBands[groupKey] = Array.from(connectorGroups.values()).map((group) => {
          const connector = buildGroupedConnector({
            sources: group.sources,
            targetX: group.targetX,
            targetY: group.targetY,
          });
          return {
            id: group.id,
            d: connector.d,
            arrowD: connector.arrowD,
          };
        });
      }

      const winners = grouped.find((group) => group.groupName === "Winners");
      const losers = grouped.find((group) => group.groupName === "Losers");
      const grandFinal = grouped.find((group) => group.groupName === "Grand Final");
      const finalMatch = grandFinal?.rounds?.[0]?.matches?.[0];
      const finalLinks = [];

      if (treeNode && finalMatch) {
        const finalBandNode = bandRefs.current.get("grand-final");
        const finalNode = matchRefs.current.get(
          getMatchKey("Grand Final", grandFinal.rounds[0].roundNumber, finalMatch.id)
        );
        const finalSources = [
          { group: winners, className: "is-winners", sideIndex: 0 },
          { group: losers, className: "is-losers", sideIndex: 1 },
        ]
          .map(({ group, className, sideIndex }) => {
            const sourceRound = group?.rounds?.[group.rounds.length - 1];
            const sourceMatch = sourceRound?.matches?.[sourceRound.matches.length - 1];
            const sourceNode = sourceMatch
              ? matchRefs.current.get(
                  getMatchKey(
                    group.groupName,
                    sourceRound.roundNumber,
                    sourceMatch.id
                  )
                )
              : null;

            return {
              className,
              group,
              sideIndex,
              sourceMatch,
              sourceNode,
            };
          })
          .filter(({ sourceNode }) => sourceNode);

        finalSources.forEach(({ className, sideIndex, sourceMatch, sourceNode }) => {
          if (!sourceNode || !finalNode) return;

          const source = getNodeCenter({
            node: sourceNode,
            root: treeNode,
            scale: unitScale,
          });
          const finalSideNode =
            finalNode.querySelectorAll(".tourney-match-side")[sideIndex] ||
            finalNode;
          const targetSide = getNodeCenter({
            node: finalSideNode,
            root: treeNode,
            scale: unitScale,
          });
          const finalBand = finalBandNode
            ? getNodeCenter({
                node: finalBandNode,
                root: treeNode,
                scale: unitScale,
              })
            : targetSide;
          const endX = finalBand.left - finalConnectorFloatGapPx;
          const startX = source.right + connectorCardGapPx;
          const lineEndX = endX - connectorArrowSizePx;
          finalLinks.push({
            id: `${className}-${sourceMatch.id}-${finalMatch.id}`,
            className,
            d: buildStepPath({
              startX,
              startY: source.y,
              endX: lineEndX,
              endY: targetSide.y,
            }),
            arrowD: buildArrowPath({
              direction: "right",
              x: endX,
              y: targetSide.y,
            }),
          });
        });
      }

      const next = { bands: nextBands, finals: finalLinks };
      setMatchOffsets((current) =>
        JSON.stringify(current) === JSON.stringify(nextMatchOffsets)
          ? current
          : nextMatchOffsets
      );
      setConnectors((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next
      );
    };

    const scheduleMeasure = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(measure);
    };

    scheduleMeasure();
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    if (treeRef.current) resizeObserver.observe(treeRef.current);
    for (const node of bandRefs.current.values()) resizeObserver.observe(node);
    for (const node of matchRefs.current.values()) resizeObserver.observe(node);
    window.addEventListener("resize", scheduleMeasure);
    document.fonts?.ready?.then(scheduleMeasure).catch(() => {});

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [grouped, matchOffsets]);

  const [winners, losers, grandFinal] = groupOrder.map((groupName) =>
    grouped.find((group) => group.groupName === groupName)
  );
  const laneGroups = [winners, losers].filter(Boolean);

  const renderMatch = ({ match, placement = {}, groupName, roundNumber }) => (
    <article
      className={`tourney-match-card ${matchStatusClass(match)}`}
      key={match.id}
      ref={registerMatch(groupName, roundNumber, match.id)}
      style={{
        ...placement,
        "--match-y-adjust": `${
          matchOffsets[getMatchKey(groupName, roundNumber, match.id)] || 0
        }px`,
      }}
    >
      <header>
        <span>{match.displayLabel || match.label}</span>
        <strong>Best of {match.bestOf}</strong>
      </header>
      <div className="tourney-match-sides">
        {[match.opponent1, match.opponent2].map((side) => {
          const showByeBadge =
            side.teamId &&
            byeTeams.has(`${groupName}:${side.teamId}`) &&
            firstVisibleRounds.get(`${groupName}:${side.teamId}`) ===
              roundNumber;
          return (
            <div
              className={`tourney-match-side ${sideClass(side)}`}
              key={side.side}
            >
              <span>
                <strong>{side.name}</strong>
                {side.forfeit ? <small>Forfeit</small> : null}
                {showByeBadge ? (
                  <small className="tourney-match-bye">Bye</small>
                ) : null}
              </span>
              <b>{scoreText(side.score)}</b>
            </div>
          );
        })}
      </div>
      {match.statusLabel || match.nextLabels?.length > 0 ? (
        <footer>
          {match.statusLabel ? <span>{match.statusLabel}</span> : null}
          {match.nextLabels?.length > 0 ? (
            <small>{match.nextLabels.join(" / ")}</small>
          ) : null}
        </footer>
      ) : null}
      {renderControls ? renderControls(match) : null}
    </article>
  );

  const renderGroup = (group, { finals = false } = {}) => {
    const roundSize = maxRoundMatches(group);
    const stackHeight =
      roundSize * connectorSlotHeightRem +
      Math.max(0, roundSize - 1) * connectorSlotGapRem;
    const groupKey = slugClass(group.groupName);

    return (
      <section
        className={`tourney-bracket-band is-${slugClass(group.groupName)} ${
          finals ? "is-finals-rail" : ""
        }`}
        key={group.groupName}
        ref={registerBand(group.groupName)}
        style={{
          "--round-size": roundSize,
          "--round-count": group.rounds.length,
          "--round-stack-height": `${stackHeight.toFixed(2)}rem`,
        }}
      >
        <header className="tourney-bracket-band-head">
          <h3>{groupDisplayName(group.groupName)}</h3>
          <span className="tourney-bracket-round-count">
            {groupSummaryLabel(group)}
          </span>
        </header>
        <svg
          className="tourney-bracket-connectors"
          aria-hidden="true"
          focusable="false"
        >
          {(connectors.bands[groupKey] || []).map((path) => (
            <path
              className="tourney-bracket-connector-path"
              d={path.d}
              key={path.id}
            />
          ))}
          {(connectors.bands[groupKey] || []).map((path) => (
            <path
              className="tourney-bracket-connector-arrow"
              d={path.arrowD}
              key={`${path.id}-head`}
            />
          ))}
        </svg>
        <div className="tourney-bracket-rounds">
          {group.rounds.map((round) => {
            return (
              <div
                className="tourney-bracket-round"
                key={round.roundNumber}
              >
                <p className="tourney-bracket-round-label">
                  <span>{roundDisplayName({ group, round })}</span>
                </p>
                <div className="tourney-bracket-stack">
                  {round.matches.map((match, matchIndex) =>
                    renderMatch({
                      match,
                      groupName: group.groupName,
                      roundNumber: round.roundNumber,
                      placement: getMatchPlacement({
                        roundSize,
                        matchCount: round.matches.length,
                        index: matchIndex,
                      }),
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="tourney-bracket-board" aria-label="Tournament bracket">
      <div
        className="tourney-bracket-tree"
        ref={treeRef}
        style={
          grandFinal
            ? undefined
            : { "--bracket-final-lane-width": "0px" }
        }
      >
        <svg
          className="tourney-bracket-stage-connectors"
          aria-hidden="true"
          focusable="false"
        >
          {connectors.finals.map((path) => (
            <path
              className={`tourney-bracket-stage-path ${path.className}`}
              d={path.d}
              key={path.id}
            />
          ))}
          {connectors.finals.map((path) => (
            <path
              className={`tourney-bracket-stage-arrow ${path.className}`}
              d={path.arrowD}
              key={`${path.id}-head`}
            />
          ))}
        </svg>
        <div className="tourney-bracket-lanes">
          {laneGroups.map((group) => renderGroup(group))}
        </div>
        {grandFinal ? (
          <aside className="tourney-finals-rail">
            {renderGroup(grandFinal, { finals: true })}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
