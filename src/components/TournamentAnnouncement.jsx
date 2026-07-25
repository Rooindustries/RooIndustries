import React from "react";
import { ArrowRight, Trophy } from "lucide-react";

export default function TournamentAnnouncement() {
  return (
    <section
      className="home-tourney-announcement"
      aria-labelledby="home-tourney-announcement-title"
    >
      <div className="home-tourney-announcement-shell glass-premium glass-scroll-lite">
        <p className="home-tourney-announcement-kicker">
          <Trophy aria-hidden="true" size={16} strokeWidth={2.2} />
          Roo Industries Tournament
        </p>
        <h2 id="home-tourney-announcement-title">
          Team captains are set. Registration is closed.
        </h2>
        <p className="home-tourney-announcement-body">
          The 12-team Overwatch 6v6 Legacy Series draft is July 26 at 19:00 UTC,
          with the tournament running August 15-16. Captains, rosters, rules,
          and the live bracket are all in one place.
        </p>
        <a className="home-tourney-announcement-button glow-button" href="/tourney">
          <span>Go to the tournament page</span>
          <ArrowRight aria-hidden="true" size={17} strokeWidth={2.2} />
          <span className="glow-line glow-line-top" />
          <span className="glow-line glow-line-right" />
          <span className="glow-line glow-line-bottom" />
          <span className="glow-line glow-line-left" />
        </a>
      </div>
    </section>
  );
}
