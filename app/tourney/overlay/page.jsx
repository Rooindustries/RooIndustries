import {
  Section,
  TourneyPromotionLinks,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import { OverlayStyles } from "./OverlayStyles";
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
    "One-click browser sources for the live 6v6 Legacy Series bracket: full bracket, lane sources, grand final card, and the live match strip.",
};

const GUIDE_LINKS = [
  { href: "#walkthrough", num: "00", label: "Walkthrough" },
  { href: "#full-bracket", num: "01", label: "Full bracket" },
  { href: "#winners-lane", num: "02", label: "Winners lane" },
  { href: "#losers-lane", num: "03", label: "Losers lane" },
  { href: "#grand-final", num: "04", label: "Grand Final" },
  { href: "#match-strip", num: "05", label: "Live match strip" },
  { href: "#layouts", num: "06", label: "Scene ideas" },
  { href: "#troubleshooting", num: "07", label: "Troubleshooting" },
  { href: "#api", num: "08", label: "API" },
];

const GuideSection = ({
  id,
  number,
  title,
  children,
}) => (
  <section className="ov-guide-section" id={id}>
    <header className="ov-guide-header">
      <span className="ov-guide-num" aria-hidden="true">{number}</span>
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
        <TourneyPromotionLinks />
        <div className="ov-docs-grid">
          <p className="ov-guide-lede">
            Everything on this page is a URL. Copy one, paste it into OBS as
            a Browser source, set the size next to it — the overlay scales
            itself to fill whatever size you pick. That is the whole job:
            no accounts, no plugins, and it keeps itself updated while the
            event runs.
          </p>

          <div className="ov-guide-layout">
            <nav className="ov-guide-rail" aria-label="Guide contents">
              {GUIDE_LINKS.map((link) => (
                <a href={link.href} key={link.href}>
                  <b>{link.num}</b>
                  {link.label}
                </a>
              ))}
            </nav>

            <div className="ov-guide-main">
              <details className="ov-guide-fold" id="walkthrough">
                <summary>
                  Never added a browser source? Two minutes, with pictures.
                </summary>
                <div className="ov-guide-fold-body">
                  <p>
                    Every overlay here is added the same way, so learn the
                    routine once. The screens below are OBS 32.2; on older
                    versions the first two clicks look a little different,
                    covered at the end.
                  </p>
                  <div className="ov-figures">
                    <figure className="ov-figure">
                      <ObsFigureAddSource />
                      <figcaption>
                        In the <strong>Sources</strong> dock at the bottom of
                        OBS, click <strong>+</strong> and choose{" "}
                        <strong>Add Source</strong>.
                      </figcaption>
                    </figure>
                    <figure className="ov-figure">
                      <ObsFigureNameSource />
                      <figcaption>
                        Pick <strong>Browser</strong> in the left list, then
                        click <strong>+ Add a new Browser</strong>. The
                        properties window opens by itself; OBS names the
                        source for you.
                      </figcaption>
                    </figure>
                    <figure className="ov-figure">
                      <ObsFigureProperties />
                      <figcaption>
                        Paste the <strong>URL</strong>, set the{" "}
                        <strong>Width</strong> and <strong>Height</strong>{" "}
                        (each source lists its size), leave every other
                        option at its default, and press <strong>OK</strong>.
                        The welcome banner at the top only appears the first
                        time.
                      </figcaption>
                    </figure>
                  </div>
                  <ul className="ov-docs-params">
                    <li>
                      Everything below <strong>Width</strong> and{" "}
                      <strong>Height</strong> keeps its default: the
                      checkboxes stay unticked, Custom CSS keeps its
                      prefilled text, Page permissions stays as it is. In
                      particular keep{" "}
                      <code>Refresh browser when scene becomes active</code>{" "}
                      unticked. The overlay keeps itself live; reloading it
                      just causes a flicker.
                    </li>
                    <li>
                      The background is transparent by default, so the
                      bracket sits directly on top of your gameplay. Nothing
                      else to configure.
                    </li>
                    <li>
                      The source appears in your dock as <em>Browser</em>.
                      Right-click it and <strong>Rename</strong> it to
                      something like <em>Live bracket</em>, so several
                      overlays stay easy to tell apart.
                    </li>
                    <li>
                      On OBS 32.1 or older the + button opens a small menu
                      instead: pick <strong>Browser</strong>, type a name,
                      press OK. Everything after that works exactly the same.
                    </li>
                  </ul>
                </div>
              </details>

              <GuideSection id="full-bracket" number="01" title="Full bracket">
                <p>
                  The whole tournament on one screen: winners lane, lower
                  lane, and the grand final off to the right. The match being
                  played glows so viewers can find it, and finished matches
                  dim back.
                </p>
                <p className="ov-guide-size">
                  Browser source size: <strong>1920 × 1640</strong>, on its
                  own scene, scaled to fit. Any size works; the tree fits
                  the frame automatically.
                </p>
                <OverlayCopyUrl path="/tourney/overlay/bracket" />
                <ul className="ov-guide-suggest">
                  <li>
                    Too much empty space for your taste? Add{" "}
                    <code>&amp;scale=1.15</code> to punch in past the
                    auto-fit, or <code>&amp;scale=0.85</code> to back off.
                  </li>
                  <li>
                    Every card says TBD until the event seeds. That is
                    normal; the bracket fills in by itself.
                  </li>
                </ul>
                <GuidePreview
                  src="/tourney/overlay/bracket?bg=gradient"
                  title="Full bracket"
                  height={560}
                />
              </GuideSection>

              <GuideSection id="winners-lane" number="02" title="Winners lane">
                <p>
                  Just the winners bracket, round 1 through the winners
                  final. Good when the full tree is more bracket than your
                  layout needs.
                </p>
                <p className="ov-guide-size">
                  Browser source size: <strong>984 × 840</strong>. When it
                  shares the screen with the losers lane, keep that size and
                  scale both lane sources down together in the scene.
                </p>
                <OverlayCopyUrl path="/tourney/overlay/bracket?group=winners" />
                <GuidePreview
                  src="/tourney/overlay/bracket?group=winners&bg=gradient"
                  title="Winners lane"
                  height={430}
                />
              </GuideSection>

              <GuideSection id="losers-lane" number="03" title="Losers lane">
                <p>
                  Just the lower bracket: the elimination lane, where every
                  series ends someone&rsquo;s run. Usually the busiest part
                  of the tree once the event gets going.
                </p>
                <p className="ov-guide-size">
                  Browser source size: <strong>1480 × 840</strong>. For a
                  side-by-side layout, keep that size and scale both lane
                  sources down together in the scene.
                </p>
                <OverlayCopyUrl path="/tourney/overlay/bracket?group=losers" />
                <ul className="ov-guide-suggest">
                  <li>
                    Pair it with the winners lane for full coverage without
                    the full tree: winners left, losers right.
                  </li>
                </ul>
                <GuidePreview
                  src="/tourney/overlay/bracket?group=losers&bg=gradient"
                  title="Losers lane"
                  height={430}
                />
              </GuideSection>

              <GuideSection id="grand-final" number="04" title="Grand Final card">
                <p>
                  One card: the championship match. It stays a quiet TBD card
                  all event and turns into the match that matters when the
                  final is set.
                </p>
                <p className="ov-guide-size">
                  Browser source size: <strong>480 × 264</strong>, parked in
                  a corner of your gameplay scene. Want the big moment
                  instead? <strong>1920 × 1080</strong> on its own scene for
                  the bracket reveal.
                </p>
                <OverlayCopyUrl path="/tourney/overlay/bracket?group=grand-final" />
                <GuidePreview
                  src="/tourney/overlay/bracket?group=grand-final&bg=gradient"
                  title="Grand Final card"
                  height={330}
                />
              </GuideSection>

              <GuideSection id="match-strip" number="05" title="Live match strip">
                <p>
                  A lower-third bar with the match being played right now:
                  both teams, the score, and a LIVE badge. When nothing is
                  live it shows the next match, and when there is nothing to
                  show at all it turns itself invisible. It never covers
                  your gameplay with an empty bar.
                </p>
                <p className="ov-guide-size">
                  Browser source size: <strong>1280 × 110</strong>, bottom
                  center of your gameplay scene. Bump the width to{" "}
                  <strong>1600</strong> for wider layouts.
                </p>
                <OverlayCopyUrl path="/tourney/overlay/match?demo=1" />
                <ul className="ov-guide-suggest">
                  <li>
                    The URL keeps <code>&amp;demo=1</code> on the end so a
                    sample match stays visible while you place and size it.
                    Delete <code>&amp;demo=1</code> before you go live and
                    the strip shows real matches only.
                  </li>
                </ul>
                <details className="ov-guide-fold">
                  <summary>Several matches at once? Pin yours.</summary>
                  <div className="ov-guide-fold-body">
                    <p>
                      The strip has no way to know which game is on your
                      capture, so by default it picks the earliest running
                      match in bracket order. If your stream covers a
                      different table, say so once in the URL:
                    </p>
                    <ul className="ov-guide-suggest">
                      <li>
                        <code>&amp;team=Team%20Chosen</code> follows one team
                        through the whole event: their live match, or their
                        next one, hidden when they have neither. Exact team
                        name from the roster page; capitals don&rsquo;t
                        matter, spaces become <code>%20</code>.
                      </li>
                      <li>
                        <code>&amp;match=123</code> pins one specific match
                        by id. It shows while that match is upcoming or live
                        and hides after it completes. Ids are listed at{" "}
                        <code>/api/tourney/v1/matches</code>.
                      </li>
                      <li>
                        A pinned strip never jumps to someone else&rsquo;s
                        game. Worst case it goes invisible for a bit, which
                        beats showing the wrong match on stream.
                      </li>
                    </ul>
                  </div>
                </details>
                <GuidePreview
                  src="/tourney/overlay/match?demo=1&bg=gradient"
                  title="Live match strip"
                  height={130}
                />
              </GuideSection>

              <article className="ov-guide-section" id="layouts">
                <h3>Scene ideas that work</h3>
                <ul className="ov-docs-params">
                  <li>
                    <strong>Between maps:</strong> one <em>Bracket</em> scene
                    with the full bracket source. Cut to it during breaks,
                    cut back when the next map starts.
                  </li>
                  <li>
                    <strong>Side by side:</strong> winners lane and losers
                    lane in one scene, winners 984 × 840 beside losers
                    1480 × 840, scaled to fit the canvas. The whole story
                    without the full tree.
                  </li>
                  <li>
                    <strong>Finals:</strong> match strip over gameplay plus
                    the Grand Final card in a corner. Maximum hype, minimum
                    clutter.
                  </li>
                </ul>
              </article>

              <details className="ov-guide-fold" id="troubleshooting">
                <summary>Something looks off? Quick fixes.</summary>
                <div className="ov-guide-fold-body">
                  <ul className="ov-docs-params">
                    <li>
                      <strong>All I see is a black or checkered square.</strong>{" "}
                      That is the transparent background doing its job; it
                      only looks like something once it sits over your game.
                      To preview a source on its own, add{" "}
                      <code>&amp;bg=gradient</code> to the URL temporarily.
                    </li>
                    <li>
                      <strong>Every card says TBD.</strong> The bracket has
                      not been generated yet. It fills in automatically, and
                      there is nothing to redo on your end.
                    </li>
                    <li>
                      <strong>Scores are not moving.</strong> Updates land on
                      their own: the bracket every 10 seconds, the strip
                      every 8. Want faster? Add <code>&amp;poll=5</code>. And
                      double-check that{" "}
                      <code>Refresh browser when scene becomes active</code>{" "}
                      stayed unticked.
                    </li>
                    <li>
                      <strong>It went blurry after I resized it.</strong>{" "}
                      Don&rsquo;t drag the corners to resize. Open the
                      source&rsquo;s properties and set the Width and Height
                      there; the overlay re-renders sharp at the new size.
                    </li>
                    <li>
                      <strong>The strip is stuck showing a fake match.</strong>{" "}
                      You left <code>&amp;demo=1</code> in the URL. Remove it.
                    </li>
                    <li>
                      <strong>
                        The strip shows a different match than the one on my
                        stream.
                      </strong>{" "}
                      With several matches running at once it picks the
                      earliest one in bracket order. Pin yours with{" "}
                      <code>&amp;team=</code> or <code>&amp;match=</code>;
                      see the match strip section above.
                    </li>
                    <li>
                      <strong>I&rsquo;m on Streamlabs or XSplit.</strong>{" "}
                      Same URLs. Add their browser source or browser widget,
                      paste, set the size.
                    </li>
                  </ul>
                </div>
              </details>

              <article className="ov-guide-section" id="api">
                <h3>Building your own widget?</h3>
                <p>
                  The same live data is public JSON with open CORS. Poll
                  every few seconds and render it however you like:
                </p>
                <ul className="ov-docs-params">
                  <li>
                    <code>/api/tourney/v1/bracket</code>
                    <span>The full bracket with teams, matches, and statuses.</span>
                  </li>
                  <li>
                    <code>/api/tourney/v1/matches</code>
                    <span>A flat match list.</span>
                  </li>
                  <li>
                    <code>/api/tourney/v1/matches/live</code>
                    <span>The current and next match, for tickers.</span>
                  </li>
                </ul>
              </article>
            </div>
          </div>
        </div>
      </Section>
    </TourneyShell>
  );
}
