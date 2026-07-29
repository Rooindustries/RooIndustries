import {
  Section,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import { OverlayStyles } from "./OverlayStyles";
import OverlaySourceCard from "./OverlaySourceCard";
import OverlayCopyUrl from "./OverlayCopyUrl";
import {
  ObsFigureAddSource,
  ObsFigureNameSource,
  ObsFigureProperties,
} from "./ObsGuideFigures";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Stream Overlays | Roo Industries",
  description:
    "Step-by-step OBS setup for the live 6v6 Legacy Series bracket: full bracket, lane sources, grand final card, and the live match strip.",
};

const BRACKET_PARAMS = [
  {
    name: "?poll=10",
    text: "Seconds between live updates (3–60, default 10).",
  },
  {
    name: "?scale=1",
    text: "Zoom multiplier on top of the automatic fit (0.35–2, default 1). The bracket always fits the source frame; go above 1 to zoom in, below 1 to zoom out.",
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
  {
    name: "?team=Team Chosen",
    text: "Follow one team all event: their live match, else their next one, else hidden. Exact team name, not case-sensitive.",
  },
  {
    name: "?match=123",
    text: "Pin one specific match by id. Shows while it is upcoming or live, hides after it completes. Ids are listed at /api/tourney/v1/matches.",
  },
];

const GuideSection = ({
  id,
  step,
  title,
  children,
}) => (
  <section className="ov-guide-section" id={id}>
    <header className="ov-guide-header">
      <span className="ov-guide-step">{step}</span>
      <h3>{title}</h3>
    </header>
    {children}
  </section>
);

const GuidePreview = ({ src, title, height }) => (
  <div className="ov-docs-preview">
    <iframe
      src={src}
      title={`${title} preview`}
      loading="lazy"
      style={{ height }}
    />
  </div>
);

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
          <p className="ov-guide-lede">
            Everything on this page is a URL. Paste one into OBS as a Browser
            source and it shows the live 6v6 Legacy Series bracket on your
            stream, updating on its own while the event runs. No accounts, no
            plugins, no cache clearing. Never added a browser source before?
            The whole thing takes about two minutes, and the walkthrough below
            shows every click.
          </p>

          <nav className="ov-guide-toc" aria-label="Guide contents">
            <a href="#full-bracket">Full bracket</a>
            <a href="#winners-lane">Winners lane</a>
            <a href="#losers-lane">Losers lane</a>
            <a href="#grand-final">Grand Final</a>
            <a href="#match-strip">Live match strip</a>
            <a href="#layouts">Scene ideas</a>
            <a href="#troubleshooting">Troubleshooting</a>
          </nav>

          <article className="ov-docs-card" id="walkthrough">
            <h3>First time? How a browser source works</h3>
            <p>
              Every overlay here is added the same way. Learn these four steps
              once and you can set up any of the sources below in under a
              minute.
            </p>
            <div className="ov-figures">
              <figure className="ov-figure">
                <ObsFigureAddSource />
                <figcaption>
                  In the <strong>Sources</strong> dock at the bottom of OBS,
                  click <strong>+</strong> and pick <strong>Browser</strong>.
                </figcaption>
              </figure>
              <figure className="ov-figure">
                <ObsFigureNameSource />
                <figcaption>
                  Give it a name you will recognize later, like
                  &ldquo;Live bracket&rdquo;, and hit <strong>OK</strong>.
                </figcaption>
              </figure>
              <figure className="ov-figure">
                <ObsFigureProperties />
                <figcaption>
                  Paste the <strong>URL</strong>, set the{" "}
                  <strong>Width</strong> and <strong>Height</strong> (each
                  source below lists its size), and press{" "}
                  <strong>OK</strong>.
                </figcaption>
              </figure>
            </div>
            <ul className="ov-docs-params">
              <li>
                Leave <code>Refresh browser when scene becomes active</code>{" "}
                unticked. The overlay keeps itself live; reloading it just
                causes a flicker.
              </li>
              <li>
                The background is transparent by default, so the bracket sits
                directly on top of your gameplay. Nothing else to configure.
              </li>
              <li>
                That is the entire job. Every source below is these same four
                steps with a different URL and size.
              </li>
            </ul>
          </article>

          <GuideSection id="full-bracket" step="Source 1" title="Full bracket">
            <p>
              The whole tournament on one screen: winners lane, lower lane,
              and the grand final off to the right. The match being played
              right now glows so viewers can find it, and finished matches dim
              back so the bracket reads top to bottom.
            </p>
            <h4>Set it up</h4>
            <ol className="ov-guide-steps">
              <li>
                Sources dock → <strong>+</strong> → <strong>Browser</strong>.
              </li>
              <li>
                Name it <em>Full bracket</em> and press OK.
              </li>
              <li>Paste this URL:</li>
            </ol>
            <OverlayCopyUrl path="/tourney/overlay/bracket" />
            <ol className="ov-guide-steps" start={4}>
              <li>
                Width <strong>1920</strong>, Height <strong>1080</strong>,
                press OK.
              </li>
              <li>
                Give it its own scene (call the scene <em>Bracket</em>) so you
                can cut to it between maps.
              </li>
            </ol>
            <h4>Suggestions</h4>
            <ul className="ov-guide-suggest">
              <li>
                Let it fill the frame. The tree fits itself to whatever size
                you set, and it reads best when it has the whole screen.
              </li>
              <li>
                Too much empty space for your taste? Add{" "}
                <code>&amp;scale=1.15</code> to punch in past the auto-fit, or{" "}
                <code>&amp;scale=0.85</code> to back off.
              </li>
              <li>
                Before the event seeds, every card says TBD. That is normal.
                The bracket fills in by itself the moment it is generated, and
                you never touch the source again.
              </li>
            </ul>
            <GuidePreview
              src="/tourney/overlay/bracket?bg=gradient"
              title="Full bracket"
              height={560}
            />
          </GuideSection>

          <GuideSection id="winners-lane" step="Source 2" title="Winners lane">
            <p>
              Just the winners bracket, round 1 through the winners final.
              Good when the full tree is more bracket than your layout needs,
              or when you want one lane on each half of the screen.
            </p>
            <h4>Set it up</h4>
            <ol className="ov-guide-steps">
              <li>
                Sources dock → <strong>+</strong> → <strong>Browser</strong>.
              </li>
              <li>
                Name it <em>Winners lane</em> and press OK.
              </li>
              <li>Paste this URL:</li>
            </ol>
            <OverlayCopyUrl path="/tourney/overlay/bracket?group=winners" />
            <ol className="ov-guide-steps" start={4}>
              <li>
                Width <strong>960</strong>, Height <strong>1080</strong> if
                you plan to pair it with the losers lane, or{" "}
                <strong>1280×720</strong> on its own. Press OK.
              </li>
              <li>Drag it into place on your bracket scene.</li>
            </ol>
            <h4>Suggestions</h4>
            <ul className="ov-guide-suggest">
              <li>
                The classic layout: winners lane on the left half, losers lane
                on the right half, both at 960×1080 on a 1080p canvas. Every
                card stays readable.
              </li>
              <li>
                Only covering winners matches on your stream? This is the only
                bracket source you need.
              </li>
            </ul>
            <GuidePreview
              src="/tourney/overlay/bracket?group=winners&bg=gradient"
              title="Winners lane"
              height={430}
            />
          </GuideSection>

          <GuideSection id="losers-lane" step="Source 3" title="Losers lane">
            <p>
              Just the lower bracket: the elimination lane, where every series
              ends someone&rsquo;s run. Once the event gets going this is
              usually the busiest part of the tree.
            </p>
            <h4>Set it up</h4>
            <ol className="ov-guide-steps">
              <li>
                Sources dock → <strong>+</strong> → <strong>Browser</strong>.
              </li>
              <li>
                Name it <em>Losers lane</em> and press OK.
              </li>
              <li>Paste this URL:</li>
            </ol>
            <OverlayCopyUrl path="/tourney/overlay/bracket?group=losers" />
            <ol className="ov-guide-steps" start={4}>
              <li>
                Width <strong>960</strong>, Height <strong>1080</strong> for a
                side-by-side layout, or <strong>1280×720</strong> solo. Press
                OK.
              </li>
              <li>Drag it next to the winners lane if you run both.</li>
            </ol>
            <h4>Suggestions</h4>
            <ul className="ov-guide-suggest">
              <li>
                Pair it with the winners lane for full coverage without the
                full tree: winners left, losers right.
              </li>
              <li>
                Following one team&rsquo;s lower-bracket run? This lane plus
                the live match strip below covers the whole story.
              </li>
            </ul>
            <GuidePreview
              src="/tourney/overlay/bracket?group=losers&bg=gradient"
              title="Losers lane"
              height={430}
            />
          </GuideSection>

          <GuideSection id="grand-final" step="Source 4" title="Grand Final card">
            <p>
              One card: the championship match. Nothing else on screen. It
              stays a quiet TBD card all event and turns into the match that
              matters when the final is set.
            </p>
            <h4>Set it up</h4>
            <ol className="ov-guide-steps">
              <li>
                Sources dock → <strong>+</strong> → <strong>Browser</strong>.
              </li>
              <li>
                Name it <em>Grand Final</em> and press OK.
              </li>
              <li>Paste this URL:</li>
            </ol>
            <OverlayCopyUrl path="/tourney/overlay/bracket?group=grand-final" />
            <ol className="ov-guide-steps" start={4}>
              <li>
                Width <strong>800</strong>, Height <strong>450</strong>,
                press OK.
              </li>
              <li>
                Park it in a corner of your gameplay scene during the final.
              </li>
            </ol>
            <h4>Suggestions</h4>
            <ul className="ov-guide-suggest">
              <li>
                Small and out of the way is the play here. One card stays
                readable even at 800×450, and it will not cover the game.
              </li>
              <li>
                Want a big moment instead? Set it to 1920×1080 on its own
                scene for the bracket reveal before the last series.
              </li>
            </ul>
            <GuidePreview
              src="/tourney/overlay/bracket?group=grand-final&bg=gradient"
              title="Grand Final card"
              height={330}
            />
          </GuideSection>

          <GuideSection id="match-strip" step="Source 5" title="Live match strip">
            <p>
              A lower-third bar with the match being played right now: both
              teams, the score, and a LIVE badge. When nothing is live it
              shows the next match instead, and when there is nothing to show
              at all it turns itself invisible. It will never cover your
              gameplay with an empty bar.
            </p>
            <h4>Set it up</h4>
            <ol className="ov-guide-steps">
              <li>
                Sources dock → <strong>+</strong> → <strong>Browser</strong>.
              </li>
              <li>
                Name it <em>Match strip</em> and press OK.
              </li>
              <li>
                Paste this URL, but keep the{" "}
                <code>&amp;demo=1</code> on the end for now:
              </li>
            </ol>
            <OverlayCopyUrl path="/tourney/overlay/match?demo=1" />
            <ol className="ov-guide-steps" start={4}>
              <li>
                Width <strong>1280</strong>, Height <strong>110</strong>,
                press OK.
              </li>
              <li>
                Drag it to the bottom center of your gameplay scene. The demo
                match makes it visible so you can line it up.
              </li>
              <li>
                Before you go live, edit the URL and delete{" "}
                <code>&amp;demo=1</code>. The strip then shows real matches
                only.
              </li>
            </ol>
            <h4>Suggestions</h4>
            <ul className="ov-guide-suggest">
              <li>
                Bottom center, 1280×110 is the safe spot on a 1080p canvas.
                Running a wider layout? Bump the width to 1600 and it
                stretches cleanly.
              </li>
              <li>
                The strip refreshes every 8 seconds on its own. Score updates
                land fast enough that you will never need to touch it
                mid-series.
              </li>
            </ul>
            <h4>Several matches at once? Pin yours</h4>
            <p>
              The strip shows one match, and it has no way to know which game
              is on your capture. By default it picks the earliest running
              match in bracket order, so two streams would show the same
              match. If your stream covers a different table, tell the strip
              once in the URL:
            </p>
            <ul className="ov-guide-suggest">
              <li>
                <code>&amp;team=Team%20Chosen</code> follows one team through
                the whole event. The strip shows their live match, or their
                next one, and hides when they have neither. Use the exact
                team name from the roster page; capitals don&rsquo;t matter,
                spaces become <code>%20</code>.
              </li>
              <li>
                <code>&amp;match=123</code> pins one specific match by its id.
                It shows while that match is upcoming or live and hides after
                it completes. Ids are listed at{" "}
                <code>/api/tourney/v1/matches</code>.
              </li>
              <li>
                A pinned strip never jumps to someone else&rsquo;s game. Worst
                case it goes invisible for a bit, which beats showing the
                wrong match on stream.
              </li>
            </ul>
            <GuidePreview
              src="/tourney/overlay/match?demo=1&bg=gradient"
              title="Live match strip"
              height={130}
            />
          </GuideSection>

          <article className="ov-docs-card" id="layouts">
            <h3>Scene ideas that work</h3>
            <ul className="ov-docs-params">
              <li>
                <strong>Between maps:</strong> one <em>Bracket</em> scene with
                the full bracket source. Cut to it during breaks, cut back
                when the next map starts.
              </li>
              <li>
                <strong>Side by side:</strong> winners lane and losers lane in
                one scene, 960×1080 each. The whole story without the full
                tree.
              </li>
              <li>
                <strong>Finals:</strong> match strip over gameplay plus the
                Grand Final card in a corner. Maximum hype, minimum clutter.
              </li>
            </ul>
          </article>

          <article className="ov-docs-card" id="troubleshooting">
            <h3>Something looks off?</h3>
            <ul className="ov-docs-params">
              <li>
                <strong>All I see is a black or checkered square.</strong>{" "}
                That is the transparent background doing its job; it only
                looks like something once it sits over your game. To preview a
                source on its own, add <code>&amp;bg=gradient</code> to the
                URL temporarily.
              </li>
              <li>
                <strong>Every card says TBD.</strong> The bracket has not been
                generated yet. It fills in automatically, and there is nothing
                to redo on your end.
              </li>
              <li>
                <strong>Scores are not moving.</strong> Updates land on their
                own: the bracket every 10 seconds, the strip every 8. Want
                faster? Add <code>&amp;poll=5</code>. And double-check that{" "}
                <code>Refresh browser when scene becomes active</code> stayed
                unticked.
              </li>
              <li>
                <strong>It went blurry after I resized it.</strong> Don&rsquo;t
                drag the corners to resize. Open the source&rsquo;s properties
                and set the Width and Height there; the overlay re-renders
                sharp at the new size.
              </li>
              <li>
                <strong>The strip is stuck showing a fake match.</strong> You
                left <code>&amp;demo=1</code> in the URL. Remove it.
              </li>
              <li>
                <strong>The strip shows a different match than the one on my
                stream.</strong> With several matches running at once it picks
                the earliest one in bracket order. Pin yours with{" "}
                <code>&amp;team=</code> or <code>&amp;match=</code>; see the
                match strip section above.
              </li>
              <li>
                <strong>I&rsquo;m on Streamlabs or XSplit.</strong> Same URLs.
                Add their browser source or browser widget, paste, set the
                size.
              </li>
            </ul>
          </article>

          <article className="ov-docs-card">
            <h3>Building your own widget?</h3>
            <p>
              The same live data is public JSON with open CORS. Poll every few
              seconds and render it however you like:
            </p>
            <ul className="ov-docs-params">
              <li>
                <code>/api/tourney/v1/bracket</code> — the full bracket with
                teams, matches, and statuses.
              </li>
              <li>
                <code>/api/tourney/v1/matches</code> — flat match list.
              </li>
              <li>
                <code>/api/tourney/v1/matches/live</code> — the current and
                next match, for tickers.
              </li>
            </ul>
          </article>

          <details className="ov-docs-card ov-guide-quickref">
            <summary>Quick reference: every URL and size</summary>
            <OverlaySourceCard
              title="Full Bracket"
              description="The complete live bracket with winners, lower, and grand final lanes. Match cards glow while a series is being played."
              path="/tourney/overlay/bracket"
              recommendedSize="1920×1080 on its own scene (any size works — the bracket fits the frame automatically)"
              params={BRACKET_PARAMS}
            />
            <OverlaySourceCard
              title="Live Match Strip"
              description="A compact lower-third bar showing the match being played right now, or the next match when nothing is live. Fully transparent when no match is available, so it never covers gameplay."
              path="/tourney/overlay/match"
              recommendedSize="1280×110 over your gameplay scene"
              params={STRIP_PARAMS}
            />
          </details>
        </div>
      </Section>
    </TourneyShell>
  );
}
