import {
  Section,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import { OverlayStyles } from "./OverlayStyles";
import OverlaySourceCard from "./OverlaySourceCard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Stream Overlays | Roo Industries",
  description: "OBS browser sources for the live 6v6 Legacy Series bracket.",
};

const BRACKET_PARAMS = [
  {
    name: "?poll=10",
    text: "Seconds between live updates (3–60, default 10).",
  },
  {
    name: "?scale=1",
    text: "Zoom the whole overlay (0.35–2, default 1). The full 12-team bracket fits 1920×1080 at about 0.43; a single lane fits near 0.8.",
  },
  {
    name: "?group=winners",
    text: "Show one lane only: winners, losers, or grand-final.",
  },
];

const STRIP_PARAMS = [
  {
    name: "?poll=8",
    text: "Seconds between live updates (3–60, default 8).",
  },
  {
    name: "?scale=1",
    text: "Zoom the strip (0.6–2, default 1).",
  },
  {
    name: "?demo=1",
    text: "Always show a sample match so you can place and size the source before the event.",
  },
];

export default async function TourneyOverlayIndexPage() {
  const session = await getTourneySession();

  return (
    <TourneyShell session={session} activeHref="/tourney/bracket" wide>
      <OverlayStyles />
      <Section
        id="stream-overlays"
        eyebrow="OBS"
        title="Stream Overlays"
        wide
      >
        <div className="ov-docs-grid">
          <p>
            Add these as <strong>Browser</strong> sources in OBS to show the
            live 6v6 Legacy Series bracket on stream. They render on a
            transparent background and update automatically while the event is
            running — no refresh or scene switching needed.
          </p>
          <OverlaySourceCard
            title="Full Bracket"
            description="The complete live bracket with winners, lower, and grand final lanes. Match cards glow while a series is being played."
            path="/tourney/overlay/bracket"
            recommendedSize="1920×1080 with ?scale=0.43 for the full bracket, or 1920×1080 near scale 1 with ?group= for one lane"
            params={BRACKET_PARAMS}
            previewSrc="/tourney/overlay/bracket?bg=gradient&scale=0.5"
            previewHeight={560}
          />
          <OverlaySourceCard
            title="Live Match Strip"
            description="A compact lower-third bar showing the match being played right now, or the next match when nothing is live. Fully transparent when no match is available, so it never covers gameplay."
            path="/tourney/overlay/match"
            recommendedSize="1280×110 over your gameplay scene"
            params={STRIP_PARAMS}
            previewSrc="/tourney/overlay/match?demo=1&bg=gradient"
            previewHeight={120}
          />
          <article className="ov-docs-card">
            <h3>OBS setup</h3>
            <ul className="ov-docs-params">
              <li>
                In OBS: Sources → + → <code>Browser</code> → paste the URL → set
                the width and height from the card above.
              </li>
              <li>
                Leave <code>Refresh browser when scene becomes active</code>{" "}
                unchecked — the overlay keeps itself live.
              </li>
              <li>
                The background is transparent by default; nothing else needs to
                be configured.
              </li>
              <li>
                Custom widgets can read the same data as JSON:{" "}
                <code>/api/tourney/v1/bracket</code>,{" "}
                <code>/api/tourney/v1/matches</code>, and{" "}
                <code>/api/tourney/v1/matches/live</code> (open CORS, updates
                every few seconds).
              </li>
            </ul>
          </article>
        </div>
      </Section>
    </TourneyShell>
  );
}
