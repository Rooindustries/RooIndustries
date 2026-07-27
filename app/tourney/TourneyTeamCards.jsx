const TEAM_COUNT = 12;
const TEAMS_PER_GROUP = 6;
const ROSTER_SIZE = 7;
const twitchLoginPattern = /^[a-z0-9_]{3,25}$/i;
const roleOrder = Object.freeze({
  Tank: 1,
  Damage: 2,
  Support: 3,
  Flex: 4,
});

const normalizeTeamName = (value) => String(value || "").trim().toLowerCase();

const getTwitchUrl = (value) => {
  const login = String(value || "").trim().toLowerCase();
  return twitchLoginPattern.test(login)
    ? `https://www.twitch.tv/${login}`
    : "";
};

const getRosterInitial = (player) =>
  String(player?.displayName || player?.twitchUsername || "P")
    .trim()
    .charAt(0)
    .toUpperCase() || "P";

const compareRosterPlayers = (left, right) => {
  const roleCompare =
    (roleOrder[left?.rolePlay] || Number.MAX_SAFE_INTEGER) -
    (roleOrder[right?.rolePlay] || Number.MAX_SAFE_INTEGER);
  if (roleCompare) return roleCompare;
  return String(left?.displayName || "").localeCompare(
    String(right?.displayName || "")
  );
};

const groupPlayersByTeam = (players) => {
  const playersByTeam = new Map();
  for (const player of players) {
    const teamName = normalizeTeamName(player.teamName);
    if (!teamName) continue;
    const teamPlayers = playersByTeam.get(teamName) || [];
    teamPlayers.push(player);
    playersByTeam.set(teamName, teamPlayers);
  }
  return playersByTeam;
};

const buildTeamRoster = ({ captain, playersByTeam }) => {
  if (!captain) return [];
  const assignedPlayers = playersByTeam.get(normalizeTeamName(captain.teamName)) || [];
  const assignedCaptain =
    assignedPlayers.find((player) => player.id === captain.id) || captain;
  const teammates = assignedPlayers
    .filter((player) => player.id !== assignedCaptain.id)
    .sort(compareRosterPlayers);
  return [assignedCaptain, ...teammates].slice(0, ROSTER_SIZE);
};

const PlayerAvatar = ({ player }) => {
  const profileImageUrl = String(player?.twitchProfileImageUrl || "").trim();
  return (
    <span className="tourney-team-slot-avatar" aria-hidden="true">
      {profileImageUrl ? (
        <img alt="" loading="lazy" src={profileImageUrl} />
      ) : (
        getRosterInitial(player)
      )}
    </span>
  );
};

const PlayerName = ({ player }) => {
  const displayName = player.displayName || player.twitchUsername || "Player";
  const isLive = Boolean(player.twitchLive);
  const liveTitle = String(player.twitchLiveTitle || "").trim();
  return (
    <strong className="tourney-team-captain-name">
      <span>{displayName}</span>
      {isLive ? (
        <span
          aria-label={`${displayName} is live on Twitch`}
          className="tourney-roster-live-badge"
          title={liveTitle || `${displayName} is live on Twitch`}
        >
          <span aria-hidden="true" />
          Live
        </span>
      ) : null}
    </strong>
  );
};

const PendingSlot = ({ captainSlot, slotNumber }) => (
  <li className="tourney-team-slot is-pending">
    <span className="tourney-team-slot-number">
      {String(slotNumber).padStart(2, "0")}
    </span>
    <span className="tourney-team-slot-copy">
      <strong>Pending</strong>
      <small>{captainSlot ? "Captain slot" : "Draft slot"}</small>
    </span>
  </li>
);

const PlayerSlot = ({ captainSlot, player, slotNumber }) => {
  if (!player) {
    return <PendingSlot captainSlot={captainSlot} slotNumber={slotNumber} />;
  }
  const twitchUrl = getTwitchUrl(player.twitchUsername);
  const slotClassName = [
    "tourney-team-slot",
    captainSlot ? "is-captain" : "is-player",
    player.twitchLive ? "is-live" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li className={slotClassName}>
      <PlayerAvatar player={player} />
      <span className="tourney-team-slot-copy">
        <PlayerName player={player} />
        <small>
          {captainSlot ? "Team Captain" : "Roster Player"} · {player.rolePlay}
        </small>
      </span>
      {twitchUrl ? (
        <a
          className="tourney-team-slot-twitch"
          href={twitchUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          {player.twitchUsername}
        </a>
      ) : null}
    </li>
  );
};

export default function TourneyTeamCards({ players = [] }) {
  const captainBySeed = new Map(
    players
      .filter((player) => Number(player.captainSeed) > 0)
      .map((player) => [Number(player.captainSeed), player])
  );
  const playersByTeam = groupPlayersByTeam(players);
  const teams = Array.from({ length: TEAM_COUNT }, (_, index) => index + 1);
  const groups = [
    teams.slice(0, TEAMS_PER_GROUP),
    teams.slice(TEAMS_PER_GROUP),
  ];

  return (
    <div className="tourney-team-board">
      {groups.map((teamNumbers) => {
        const firstTeam = teamNumbers[0];
        const lastTeam = teamNumbers.at(-1);
        const headingId = `tourney-team-group-${firstTeam}-${lastTeam}`;

        return (
          <section
            aria-labelledby={headingId}
            className="tourney-team-group"
            key={headingId}
          >
            <header className="tourney-team-group-heading">
              <span>Roster split</span>
              <h3 id={headingId}>
                Teams {firstTeam}–{lastTeam}
              </h3>
            </header>
            <div className="tourney-team-card-grid">
              {teamNumbers.map((teamNumber) => {
                const captain = captainBySeed.get(teamNumber);
                const roster = buildTeamRoster({ captain, playersByTeam });
                const teamName = String(captain?.teamName || "").trim();
                return (
                  <article className="tourney-team-card" key={teamNumber}>
                    <header className="tourney-team-card-heading">
                      <span>Seed {teamNumber}</span>
                      <h4>{teamName || `Team ${teamNumber}`}</h4>
                    </header>
                    <ol className="tourney-team-slots">
                      {Array.from({ length: ROSTER_SIZE }, (_, index) => (
                        <PlayerSlot
                          captainSlot={index === 0}
                          key={roster[index]?.id || `pending-${teamNumber}-${index + 1}`}
                          player={roster[index]}
                          slotNumber={index + 1}
                        />
                      ))}
                    </ol>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
