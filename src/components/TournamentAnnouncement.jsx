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
          GetSkii’d are your 6v6 Legacy Series champions.
        </h2>
        <p className="home-tourney-announcement-body">
          GetSkii’d took the grand final 4–1 against Rents Due.
          See the podium, and stay tuned for what comes next.
        </p>
        <a className="home-tourney-announcement-button glow-button" href="/tourney">
          <span>See the winners</span>
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
