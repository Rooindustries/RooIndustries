import { Medal, Trophy } from "lucide-react";
import { Section, TourneyShell } from "./TourneyShared";
import seo from "../../src/lib/seo";
import { tourneyResults as results } from "../../src/lib/tourneyResults";
import "./results.css";

export const metadata = seo.getMetadataForPath("/tourney");

function PodiumFinish({ place, label, team, medal }) {
  return (
    <li className={`tourney-podium-finish is-${medal}`} value={place}>
      {place === 1 ? (
        <div className="tourney-podium-trophy" aria-hidden="true">
          <Trophy strokeWidth={1.15} />
        </div>
      ) : (
        <div className="tourney-podium-medal" aria-hidden="true">
          <Medal strokeWidth={1.2} />
        </div>
      )}
      <div className="tourney-podium-team">
        <span className="tourney-podium-place">{label}</span>
        <h3>{team}</h3>
      </div>
      <div className="tourney-podium-step" aria-hidden="true">
        <span>{place}</span>
        <div className="tourney-podium-step-line" />
      </div>
    </li>
  );
}

export default function TourneyResultsPage() {
  return (
    <TourneyShell>
      <section className="tourney-hero" aria-labelledby="tourney-title">
        <div>
          <span className="tourney-badge">Overwatch Creator Tournament</span>
          <h1 id="tourney-title"><span className="tourney-title-line">{results.event}</span></h1>
          <p>Thank you to every player, host, caster, and everyone who watched.</p>
          <div className="tourney-registration-status" role="status">
            <strong>Event complete</strong><span>{results.dates}</span>
          </div>
        </div>
      </section>
      <div className="tourney-grid">
        <Section id="results" eyebrow="Final results" title="Our winners" wide>
          <ol className="tourney-podium" aria-label="Tournament podium" role="list">
            <PodiumFinish place={1} label="Champions" team={results.champion} medal="gold" />
            <PodiumFinish place={2} label="Runners-up" team={results.runnerUp} medal="silver" />
            <PodiumFinish place={3} label="Third place" team={results.third} medal="bronze" />
          </ol>
          <div className="tourney-final-score" aria-label={`Grand final: ${results.champion} ${results.finalScore[0]}, ${results.runnerUp} ${results.finalScore[1]}`}>
            <span className="tourney-final-label">Grand final</span>
            <div className="tourney-final-match">
              <span>{results.champion}</span>
              <strong>{results.finalScore[0]}<span aria-hidden="true">–</span>{results.finalScore[1]}</strong>
              <span>{results.runnerUp}</span>
            </div>
          </div>
        </Section>
        <Section id="next" eyebrow="The next tournament" title="Stay Tuned." wide>
          <p>Keep an eye out for what comes next.</p>
        </Section>
      </div>
    </TourneyShell>
  );
}
