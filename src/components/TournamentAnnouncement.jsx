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
          Overwatch Creator Tournament signups are open.
        </h2>
        <p className="home-tourney-announcement-body">
          We're running the Overwatch 6v6 Legacy Series on August 15-16. Signups,
          rules, roster updates, and the live bracket are all in one place for
          approved creators.
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
