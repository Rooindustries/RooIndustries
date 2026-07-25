const TEAM_COUNT = 12;
const TEAMS_PER_GROUP = 6;
const ROSTER_SIZE = 7;
const twitchLoginPattern = /^[a-z0-9_]{3,25}$/i;

const getTwitchUrl = (value) => {
  const login = String(value || "").trim().toLowerCase();
  return twitchLoginPattern.test(login)
    ? `https://www.twitch.tv/${login}`
    : "";
};

const getRosterInitial = (player) =>
  String(player?.displayName || player?.twitchUsername || "C")
    .trim()
    .charAt(0)
    .toUpperCase() || "C";

const CaptainSlot = ({ captain }) => {
  if (!captain) {
    return (
      <li className="tourney-team-slot is-pending">
        <span className="tourney-team-slot-number">01</span>
        <span className="tourney-team-slot-copy">
          <strong>Pending</strong>
          <small>Captain slot</small>
        </span>
      </li>
    );
  }

  const twitchUrl = getTwitchUrl(captain.twitchUsername);
  const profileImageUrl = String(
    captain.twitchProfileImageUrl || ""
  ).trim();

  return (
    <li className="tourney-team-slot is-captain">
      <span className="tourney-team-slot-avatar" aria-hidden="true">
        {profileImageUrl ? (
          <img alt="" loading="lazy" src={profileImageUrl} />
        ) : (
          getRosterInitial(captain)
        )}
      </span>
      <span className="tourney-team-slot-copy">
        <strong>{captain.displayName || captain.twitchUsername}</strong>
        <small>Team Captain · {captain.rolePlay}</small>
      </span>
      {twitchUrl ? (
        <a
          className="tourney-team-slot-twitch"
          href={twitchUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          {captain.twitchUsername}
        </a>
      ) : null}
    </li>
  );
};

const PendingSlot = ({ slotNumber }) => (
  <li className="tourney-team-slot is-pending">
    <span className="tourney-team-slot-number">
      {String(slotNumber).padStart(2, "0")}
    </span>
    <span className="tourney-team-slot-copy">
      <strong>Pending</strong>
      <small>Draft slot</small>
    </span>
  </li>
);

export default function TourneyTeamCards({ players = [] }) {
  const captainBySeed = new Map(
    players
      .filter((player) => Number(player.captainSeed) > 0)
      .map((player) => [Number(player.captainSeed), player])
  );
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
              {teamNumbers.map((teamNumber) => (
                <article className="tourney-team-card" key={teamNumber}>
                  <header className="tourney-team-card-heading">
                    <span>Roster</span>
                    <h4>Team {teamNumber}</h4>
                  </header>
                  <ol className="tourney-team-slots">
                    <CaptainSlot captain={captainBySeed.get(teamNumber)} />
                    {Array.from(
                      { length: ROSTER_SIZE - 1 },
                      (_, index) => (
                        <PendingSlot
                          key={index + 2}
                          slotNumber={index + 2}
                        />
                      )
                    )}
                  </ol>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
