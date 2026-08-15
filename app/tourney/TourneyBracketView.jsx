"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

const groupOrder = ["Winners", "Losers", "Grand Final"];
const connectorSlotHeightRem = 10.5;
const connectorSlotGapRem = 1;
const connectorBranchMinPx = 8;

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

// Scheduled matches carry advancement labels for unresolved slots
// ("Winner of 5" / "Loser of 17"). Show them in place of a bare TBD, but
// never overwrite a real populated team name.
const scheduledSideName = ({ match, side }) => {
  const hasTeam = Boolean(side?.teamId) || (side?.name && side.name !== "TBD");
  if (hasTeam) return side?.name || "TBD";
  return match?.slotLabels?.[side?.side] || side?.name || "TBD";
};

// Round headers stay one line inside the fixed card-width columns, so drop
// the year from "August 15, 2026".
const shortScheduleDate = (dateLabel) =>
  String(dateLabel || "").replace(/,\s*\d{4}$/, "");

const sideClass = (side) => {
  if (side.result === "win") return "is-win";
  if (side.result === "loss") return "is-loss";
  if (side.status === "disqualified") return "is-loss";
  return "";
};

// Overlay matches carry a raw statusSlug because their statusLabel is already
// remapped (running -> "LIVE" etc.); the site bracket falls back to the label.
const matchStatusClass = (match) =>
  `is-${slugClass(match.statusSlug || match.statusLabel) || "unknown"}`;

const scoreText = (score) => (score === "" || score === undefined ? "-" : score);

// The full display label repeats the column's round label above every card
// ("Winners Round 1 Match 2" under a "Winners Round 1" column). Trim that
// prefix down to the match number; distinctive labels (finals) stay whole.
const shortMatchLabel = (match) => {
  const label = (match.displayLabel || match.label || "").replace(
    /^Lower\b/,
    "Losers"
  );
  const tail = label.match(/Match\s+(\d+)$/i);
  return tail ? `Match ${tail[1]}` : label;
};

const maxRoundMatches = (group) =>
  Math.max(...group.rounds.map((round) => round.matches.length), 1);

const groupDisplayName = (groupName) => {
  if (groupName === "Winners") return "Winners Bracket";
  if (groupName === "Losers") return "Losers Bracket";
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
    if (roundsFromFinal === 0) return "Losers Final";
    if (roundsFromFinal === 1) return "Losers Semifinals";
    return `Losers Round ${roundNumber}`;
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
// winners matches with 4 bye slots hidden, plus the visible lower lane.
// Exported so the OBS overlay can lane-filter the same skeleton.
export const buildTbdBracketMatches = () => [
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
  ...[1, 2].map((number) =>
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
  createTbdMatch({
    id: "tbd-lower-semifinal",
    groupName: "Losers",
    groupNumber: 2,
    roundNumber: 4,
    number: 1,
    displayLabel: "Lower Semifinal",
  }),
  createTbdMatch({
    id: "tbd-lower-final",
    groupName: "Losers",
    groupNumber: 2,
    roundNumber: 5,
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

// The OBS overlay fits the frame by scaling an ancestor with a CSS
// transform: getBoundingClientRect returns scale-adjusted px while SVG path
// user units stay in unscaled layout px. Dividing rect deltas by the tree's
// rendered scale converts measurements into path space so connectors land
// on the cards at any zoom level.
const getNodeCenter = ({ node, root, scale = 1 }) => {
  const nodeRect = node.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  const unit = scale > 0 && Number.isFinite(scale) ? scale : 1;

  return {
    left: (nodeRect.left - rootRect.left) / unit,
    right: (nodeRect.right - rootRect.left) / unit,
    top: (nodeRect.top - rootRect.top) / unit,
    y: (nodeRect.top - rootRect.top + nodeRect.height / 2) / unit,
  };
};

const formatPoint = (value) => value.toFixed(1);

const buildGroupedConnector = ({ sources, targetX, targetY }) => {
  const primaryStartX = Math.max(...sources.map((source) => source.x));
  const branchEndX = Math.max(targetX, primaryStartX + connectorBranchMinPx);
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

export const collapseLosersByeRoundMatches = (matches = []) => {
  const losersMatches = matches.filter((match) => match.groupName === "Losers");
  const roundNumbers = [...new Set(
    losersMatches.map((match) => match.roundNumber)
  )];
  const autoAdvanceRound = roundNumbers.find((roundNumber) => {
    const roundMatches = losersMatches.filter(
      (match) => match.roundNumber === roundNumber
    );
    return (
      roundMatches.length === 4 &&
      roundMatches.every(
        (match) =>
          match.publicMatchNumber == null &&
          (match.autoAdvance || isAutoAdvanceMatch(match))
      )
    );
  });
  const byeRoundNumber = autoAdvanceRound ?? 2;

  return matches
    .filter(
      (match) =>
        !(match.groupName === "Losers" && match.roundNumber === byeRoundNumber)
    )
    .map((match) =>
      match.groupName === "Losers" && match.roundNumber > byeRoundNumber
        ? { ...match, roundNumber: match.roundNumber - 1 }
        : match
    );
};

export default function TourneyBracketView({
  snapshot,
  renderControls,
  showSchedule = false,
  collapseLosersByeRound = false,
}) {
  const { matches, byeTeams } = useMemo(() => {
    const snapshotMatches = snapshot?.matches || [];
    const sourceMatches =
      snapshot?.generated && collapseLosersByeRound
        ? collapseLosersByeRoundMatches(snapshotMatches)
        : snapshotMatches;
    if (!snapshot?.generated) {
      // Callers (the OBS overlay lane sources) may pass a pre-filtered
      // skeleton; only build the full skeleton when nothing was supplied.
      return {
        matches: sourceMatches.length > 0 ? sourceMatches : buildTbdBracketMatches(),
        byeTeams: new Set(),
      };
    }
    if (sourceMatches.length === 0) {
      return { matches: buildTbdBracketMatches(), byeTeams: new Set() };
    }
    const byeTeams = new Set();
    const visible = sourceMatches.filter((match) => {
      const hideMatch =
        isAutoAdvanceMatch(match) || (showSchedule && match?.autoAdvance);
      if (!hideMatch) return true;
      const winner = [match.opponent1, match.opponent2].find(
        (side) => side?.teamId
      );
      if (winner) byeTeams.add(`${match.groupName}:${winner.teamId}`);
      return false;
    });
    return { matches: visible, byeTeams };
  }, [
    collapseLosersByeRound,
    showSchedule,
    snapshot?.generated,
    snapshot?.matches,
  ]);
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
  const boardRef = useRef(null);
  const bandRefs = useRef(new Map());
  const matchRefs = useRef(new Map());
  const [connectors, setConnectors] = useState({ bands: {}, finals: [] });
  const [matchOffsets, setMatchOffsets] = useState({});
  const [scrollMetrics, setScrollMetrics] = useState({
    maxScroll: 0,
    hasOverflow: false,
  });
  const [scrollLeft, setScrollLeft] = useState(0);

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

  const syncHorizontalScroll = useCallback((event) => {
    setScrollLeft(event.currentTarget.scrollLeft);
  }, []);

  const setHorizontalScroll = useCallback(
    (value) => {
      const nextScrollLeft = Math.min(
        Math.max(Number(value) || 0, 0),
        scrollMetrics.maxScroll
      );
      if (
        boardRef.current &&
        boardRef.current.scrollLeft !== nextScrollLeft
      ) {
        boardRef.current.scrollLeft = nextScrollLeft;
      }
      setScrollLeft(nextScrollLeft);
    },
    [scrollMetrics.maxScroll]
  );

  useLayoutEffect(() => {
    const board = boardRef.current;
    const tree = treeRef.current;
    if (!board || !tree) return undefined;

    const measureScroll = () => {
      const contentWidth = Math.max(board.scrollWidth, tree.scrollWidth);
      const maxScroll = Math.max(0, contentWidth - board.clientWidth);
      const hasOverflow = maxScroll > 1;
      setScrollMetrics((current) =>
        current.maxScroll === maxScroll && current.hasOverflow === hasOverflow
          ? current
          : { maxScroll, hasOverflow }
      );
      if (board.scrollLeft > maxScroll) board.scrollLeft = maxScroll;
      setScrollLeft((current) => Math.min(current, maxScroll));
    };

    measureScroll();
    const resizeObserver = new ResizeObserver(measureScroll);
    resizeObserver.observe(board);
    resizeObserver.observe(tree);
    window.addEventListener("resize", measureScroll);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measureScroll);
    };
  }, [grouped]);

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
          // Cards are nudged toward their connector sources with a transform,
          // which reserves no layout space: when a later round's cards are
          // taller than the round feeding them (scheduled cards carrying
          // caster, bye, and status lines), center-pinning compresses the
          // visual pitch below the card height and neighbours overlap,
          // ghosting rounded borders across the gaps on narrow screens.
          // Clamp each offset so a card's translated top never crosses the
          // previous card's translated bottom plus the stack gap; the next
          // measure pass redraws the connectors to wherever the cards land.
          let previousVisualBottom = null;
          let stackGapPx = 0;
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
            const node = matchRefs.current.get(key);
            const baselineCenter = baselineCenters.get(key);
            if (!node || baselineCenter === undefined) return;
            if (previousVisualBottom === null && node.parentElement) {
              stackGapPx =
                parseFloat(getComputedStyle(node.parentElement).rowGap) || 0;
            }

            const desiredCenter =
              sourceCenters.length > 0
                ? sourceCenters.reduce((sum, center) => sum + center, 0) /
                  sourceCenters.length
                : baselineCenter;
            const cardHeight = node.offsetHeight;
            const naturalTop = baselineCenter - cardHeight / 2;
            const stackTop = node.parentElement
              ? getNodeCenter({
                  node: node.parentElement,
                  root: connectorNode,
                  scale: unitScale,
                }).top
              : naturalTop;
            const minTop =
              previousVisualBottom === null
                ? stackTop
                : previousVisualBottom + stackGapPx;
            let offset = roundPixel(desiredCenter - baselineCenter);
            if (naturalTop + offset < minTop) {
              offset = roundPixel(minTop - naturalTop);
            }
            previousVisualBottom = naturalTop + offset + cardHeight;
            desiredCenters.set(key, roundPixel(baselineCenter + offset));
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
            // A bye-fed card hides its other first-round source, so the card
            // center is not the slot the visible source feeds. Aim at the
            // side row that actually receives the winner instead.
            const byeSideIndexes = [targetMatch?.opponent1, targetMatch?.opponent2]
              .map((side, index) =>
                side?.teamId && byeTeams.has(`${group.groupName}:${side.teamId}`)
                  ? index
                  : -1
              )
              .filter((index) => index !== -1);
            const fedSideNode =
              byeSideIndexes.length === 1
                ? targetNode.querySelectorAll(".tourney-match-side")[
                    1 - byeSideIndexes[0]
                  ]
                : null;
            const targetY = fedSideNode
              ? getNodeCenter({
                  node: fedSideNode,
                  root: connectorNode,
                  scale: unitScale,
                }).y
              : target.y;
            const targetKey = getMatchKey(
              group.groupName,
              nextRound.roundNumber,
              targetMatch.id
            );
            const connectorGroup = connectorGroups.get(targetKey) || {
              id: targetKey,
              sources: [],
              targetX: target.left,
              targetY,
            };
            connectorGroup.sources.push({
              x: source.right,
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
          };
        });
      }

      const winners = grouped.find((group) => group.groupName === "Winners");
      const losers = grouped.find((group) => group.groupName === "Losers");
      const grandFinal = grouped.find((group) => group.groupName === "Grand Final");
      const finalMatch = grandFinal?.rounds?.[0]?.matches?.[0];
      const finalLinks = [];

      if (treeNode && finalMatch) {
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
          const finalCard = getNodeCenter({
            node: finalNode,
            root: treeNode,
            scale: unitScale,
          });
          const endX = finalCard.left;
          const startX = source.right;
          finalLinks.push({
            id: `${className}-${sourceMatch.id}-${finalMatch.id}`,
            className,
            d: buildStepPath({
              startX,
              startY: source.y,
              endX,
              endY: targetSide.y,
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

  const renderMatch = ({ match, placement = {}, groupName, roundNumber }) => {
    const scheduled = showSchedule && match.schedule;
    const casterLine = scheduled
      ? (match.casters || [])
          .map((caster) => caster?.label)
          .filter(Boolean)
          .join(", ")
      : "";
    // Caster color-coding is a scheduled-view-only treatment: it tints the
    // card shell behind the sides so the is-win/is-loss side semantics stay
    // untouched. Two casters get a balanced duo gradient instead of dropping
    // one color. The palette itself lives in CSS; the card only pins which
    // named caster tokens it uses.
    const casterColors = scheduled
      ? (match.casters || []).map((caster) => caster?.color).filter(Boolean)
      : [];
    const casterHighlightClass = casterColors.length
      ? ` has-caster-highlight${casterColors.length > 1 ? " has-caster-duo" : ""}${casterColors.includes("black") ? " has-caster-black" : ""}`
      : "";
    const casterHighlightStyle = casterColors.length
      ? {
          "--caster-1": `var(--caster-${casterColors[0]})`,
          ...(casterColors.length > 1
            ? { "--caster-2": `var(--caster-${casterColors[1]})` }
            : {}),
        }
      : {};
    return (
      <article
        className={`tourney-match-card ${matchStatusClass(match)}${casterHighlightClass}`}
        key={match.id}
        ref={registerMatch(groupName, roundNumber, match.id)}
        style={{
          ...placement,
          ...casterHighlightStyle,
          "--match-y-adjust": `${
            matchOffsets[getMatchKey(groupName, roundNumber, match.id)] || 0
          }px`,
        }}
      >
        <header>
          <span>
            {scheduled && match.publicMatchNumber != null
              ? `Match ${match.publicMatchNumber}`
              : shortMatchLabel(match)}
          </span>
          {/* Bo5 is the bracket-wide default and repeats on every card; only
              the Grand Final's longer series is worth calling out. */}
          {match.bestOf && match.bestOf !== 5 ? (
            <strong>Best of {match.bestOf}</strong>
          ) : null}
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
                  <strong>
                    {scheduled ? scheduledSideName({ match, side }) : side.name}
                  </strong>
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
        {scheduled && casterLine ? (
          <div className="tourney-match-schedule">
            <small>Cast: {casterLine}</small>
          </div>
        ) : null}
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
  };

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
        </svg>
        <div className="tourney-bracket-rounds">
          {group.rounds.map((round) => {
            const roundSchedule = showSchedule
              ? round.matches.find((match) => match.schedule)?.schedule || null
              : null;
            return (
              <div
                className="tourney-bracket-round"
                key={round.roundNumber}
              >
                <p className="tourney-bracket-round-label">
                  <span>
                    {roundSchedule?.stageLabel ||
                      roundDisplayName({ group, round })}
                  </span>
                </p>
                {roundSchedule ? (
                  <p className="tourney-bracket-round-schedule">
                    {roundSchedule.dayLabel} ·{" "}
                    {shortScheduleDate(roundSchedule.dateLabel)} ·{" "}
                    {roundSchedule.timeLabel} {snapshot.schedule?.timeZone || "PST"}
                  </p>
                ) : null}
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

  const scrollRailClass = `tourney-bracket-scrollbar${
    scrollMetrics.hasOverflow ? "" : " is-hidden"
  }`;
  const scrollRangeValue = Math.min(scrollLeft, scrollMetrics.maxScroll);

  return (
    <div className="tourney-bracket-scroll-shell">
      <div className="tourney-bracket-scrollbar-slot is-top">
        <div className={`${scrollRailClass} is-top`}>
          <input
            aria-label="Scroll tournament bracket horizontally from the top"
            className="tourney-bracket-scrollbar-input"
            disabled={!scrollMetrics.hasOverflow}
            max={scrollMetrics.maxScroll}
            min={0}
            onInput={(event) => setHorizontalScroll(event.currentTarget.value)}
            step={1}
            type="range"
            value={scrollRangeValue}
          />
        </div>
      </div>
      <div
        className="tourney-bracket-board"
        aria-label="Tournament bracket"
        onScroll={syncHorizontalScroll}
        ref={boardRef}
      >
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
      <div className="tourney-bracket-scrollbar-slot is-bottom">
        <div className={`${scrollRailClass} is-bottom`}>
          <input
            aria-label="Scroll tournament bracket horizontally from the bottom"
            className="tourney-bracket-scrollbar-input"
            disabled={!scrollMetrics.hasOverflow}
            max={scrollMetrics.maxScroll}
            min={0}
            onInput={(event) => setHorizontalScroll(event.currentTarget.value)}
            step={1}
            type="range"
            value={scrollRangeValue}
          />
        </div>
      </div>
    </div>
  );
}
