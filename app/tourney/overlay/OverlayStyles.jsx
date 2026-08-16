export const OverlayStyles = () => (
  <style>{`
    .tourney-page.tourney-overlay {
      min-height: 0;
      background: transparent;
      overflow: visible;
    }

    .tourney-overlay {
      --ov-live: #f43f5e;
      --ov-win: #34d399;
      --ov-card-glow: rgba(34, 211, 238, 0.32);
      scrollbar-width: none;
    }

    .tourney-overlay::-webkit-scrollbar,
    .tourney-overlay *::-webkit-scrollbar {
      display: none;
    }

    .tourney-overlay * {
      scrollbar-width: none;
    }

    /* The preview gradient must outrank both the overlay reset above
       (.tourney-page.tourney-overlay paints background: transparent, which
       also zeroes min-height) and the Blackout page background
       (html[data-theme="dark"] .tourney-page). The strip root is inline-block
       so the source shrink-wraps in OBS; in preview it goes full-bleed. */
    .tourney-page.tourney-overlay.ov-demo-bg {
      min-height: 100vh;
      background-image: linear-gradient(
        to top,
        #00b7c0 0%,
        #006185 30%,
        #001f5a 65%,
        #000040 100%
      );
    }

    .tourney-page.tourney-overlay.ov-strip.ov-demo-bg {
      display: block;
    }

    .ov-bracket {
      display: flex;
      align-items: safe center;
      justify-content: center;
      box-sizing: border-box;
      min-height: 100vh;
      padding: 8px;
    }

    /* The fit box is sized explicitly to the scaled content so flex centering
       works, while the content inside lays out at natural size and is scaled
       visually with a transform (transforms never change layout, so the fit
       measurement in OverlayFit stays stable in every engine, including the
       CEF build inside OBS browser sources). */
    .ov-fit {
      flex: 0 0 auto;
      text-align: left;
    }

    .ov-fit-content {
      width: max-content;
      transform-origin: top left;
    }

    /* The source auto-fits the whole tree into the browser-source viewport,
       so the board renders at natural content size with no clipping or
       scrollbars; the JS transform then scales it onto the frame. The finals rail
       stays wide: the Grand Final step connectors need horizontal room or
       they double back on themselves. Round gaps stay roomy too — with tight
       gaps the connector line before each arrowhead nearly disappears and
       the lanes read as cluttered. */
    .tourney-overlay .tourney-bracket-board {
      --bracket-card-width: 12rem;
      --bracket-slot-height: 7.5rem;
      --bracket-slot-gap: 0.6rem;
      --bracket-round-gap: 3.5rem;
      --bracket-lane-gap: 1.5rem;
      --bracket-final-lane-width: 28rem;
      --bracket-band-padding: 8px;
      width: max-content;
      max-width: none;
      overflow: visible;
      padding: 0;
    }

    .tourney-overlay .tourney-bracket-tree {
      padding-right: 16px;
    }

    .tourney-overlay .tourney-bracket-round-count {
      display: none;
    }

    /* Denser cards for the source: the advancement text under each match is
       redundant with the connector lines on stream, the per-card header
       repeats the round label above the column, and tighter padding keeps
       the full 12-team tree readable when it is fit onto one frame. */
    .tourney-overlay .tourney-match-card {
      gap: 6px;
      padding: 8px;
    }

    .tourney-overlay .tourney-match-card header,
    .tourney-overlay .tourney-match-card footer small {
      display: none;
    }

    .tourney-overlay .tourney-match-sides {
      gap: 5px;
    }

    .tourney-overlay .tourney-match-side {
      padding: 6px 8px;
    }

    .tourney-overlay .tourney-match-side small.tourney-match-bye {
      margin-top: 2px;
      font-size: 0.55rem;
    }

    .tourney-overlay .tourney-match-card.is-running {
      border-color: rgba(34, 211, 238, 0.68);
      box-shadow: 0 0 0 1px rgba(34, 211, 238, 0.35),
        0 0 24px var(--ov-card-glow);
      animation: ov-card-glow 2.4s ease-in-out infinite;
    }

    .tourney-overlay .tourney-match-card.is-running > footer span:first-child {
      position: relative;
      padding-left: 1.35em;
    }

    .tourney-overlay .tourney-match-card.is-running > footer span:first-child::before {
      content: "";
      position: absolute;
      left: 0.45em;
      top: 50%;
      width: 0.5em;
      height: 0.5em;
      border-radius: 50%;
      background: var(--ov-live);
      transform: translateY(-50%);
      animation: ov-pulse-dot 1.6s ease-out infinite;
    }

    .tourney-overlay .tourney-match-card.is-completed {
      opacity: 0.82;
    }

    .tourney-overlay .tourney-match-side.is-win strong {
      color: var(--tourney-side-win-text);
    }

    @keyframes ov-card-glow {
      0%,
      100% {
        box-shadow: 0 0 0 1px rgba(34, 211, 238, 0.35),
          0 0 18px rgba(34, 211, 238, 0.22);
      }
      50% {
        box-shadow: 0 0 0 1px rgba(34, 211, 238, 0.5),
          0 0 30px rgba(34, 211, 238, 0.45);
      }
    }

    @keyframes ov-pulse-dot {
      0% {
        box-shadow: 0 0 0 0 rgba(244, 63, 94, 0.55);
      }
      100% {
        box-shadow: 0 0 0 8px rgba(244, 63, 94, 0);
      }
    }

    .ov-strip {
      display: inline-block;
      padding: 10px;
      font-family: "Manrope Variable", system-ui, sans-serif;
      color: #fff;
    }

    .ov-strip[data-idle="true"] {
      padding: 0;
    }

    .ov-strip-card {
      display: flex;
      align-items: center;
      gap: 16px;
      min-width: 460px;
      max-width: 100%;
      border: 1px solid rgba(103, 232, 249, 0.3);
      border-radius: 14px;
      background: linear-gradient(
        180deg,
        rgba(7, 22, 45, 0.94),
        rgba(6, 18, 38, 0.88)
      );
      box-shadow: inset 0 1px 0 rgba(186, 230, 253, 0.1),
        0 14px 34px rgba(2, 6, 23, 0.4);
      padding: 12px 18px;
    }

    .ov-strip-card.is-live {
      border-color: rgba(244, 63, 94, 0.45);
      box-shadow: inset 0 1px 0 rgba(186, 230, 253, 0.1),
        0 14px 34px rgba(2, 6, 23, 0.4),
        0 0 26px rgba(244, 63, 94, 0.18);
    }

    .ov-strip-badge {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      flex: 0 0 auto;
      border-radius: 999px;
      font-size: 0.74rem;
      font-weight: 800;
      letter-spacing: 0.1em;
      line-height: 1;
      padding: 7px 11px;
      text-transform: uppercase;
    }

    .ov-strip-card.is-live .ov-strip-badge {
      border: 1px solid rgba(244, 63, 94, 0.6);
      background: rgba(244, 63, 94, 0.2);
      color: #fecdd3;
    }

    .ov-strip-card.is-live .ov-strip-badge::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--ov-live);
      animation: ov-pulse-dot 1.6s ease-out infinite;
    }

    .ov-strip-card.is-next .ov-strip-badge {
      border: 1px solid rgba(103, 232, 249, 0.5);
      background: rgba(8, 145, 178, 0.26);
      color: #cffafe;
    }

    .ov-strip-teams {
      flex: 1 1 auto;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      align-items: center;
      gap: 14px;
      min-width: 0;
    }

    .ov-strip-team {
      font-size: 1.12rem;
      font-weight: 800;
      letter-spacing: 0.01em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ov-strip-team.is-a {
      text-align: right;
    }

    .ov-strip-score {
      display: inline-flex;
      align-items: baseline;
      gap: 7px;
      color: #e0f2fe;
      font-size: 1.32rem;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }

    .ov-strip-score i {
      color: rgba(148, 163, 184, 0.75);
      font-size: 0.95rem;
      font-style: normal;
      font-weight: 600;
    }

    .ov-strip-score.is-vs {
      color: rgba(148, 163, 184, 0.85);
      font-size: 0.92rem;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    .ov-strip-meta {
      flex: 0 0 auto;
      max-width: 220px;
      color: rgba(148, 163, 184, 0.9);
      font-size: 0.76rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      line-height: 1.35;
      overflow: hidden;
      text-align: right;
      text-transform: uppercase;
    }

    .ov-strip-meta b {
      display: block;
      overflow: hidden;
      color: rgba(207, 250, 254, 0.92);
      font-size: 0.82rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ov-docs-grid {
      display: grid;
      gap: 16px;
    }

    .ov-docs-url {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }

    .ov-docs-url code {
      flex: 1 1 20rem;
      overflow-x: auto;
      border: 1px solid var(--tourney-border);
      border-radius: 0.5rem;
      background: var(--tourney-input);
      color: #a5f3fc;
      font-size: 0.78rem;
      padding: 9px 11px;
      white-space: nowrap;
      scrollbar-width: none;
    }

    .ov-docs-url button {
      border: 1px solid var(--tourney-border-accent);
      border-radius: 0.5rem;
      background: rgba(8, 145, 178, 0.24);
      color: #cffafe;
      cursor: pointer;
      font: inherit;
      font-size: 0.8rem;
      font-weight: 700;
      padding: 8px 14px;
    }

    .ov-docs-url button:hover {
      background: rgba(8, 145, 178, 0.4);
    }

    .ov-docs-params {
      margin: 0 0 12px;
      padding: 0;
      display: grid;
      gap: 7px;
      list-style: none;
      color: var(--tourney-text-muted);
      font-size: 0.82rem;
      line-height: 1.6;
    }

    .ov-docs-params li {
      position: relative;
      padding-left: 1.15rem;
    }

    .ov-docs-params li::before {
      content: "";
      position: absolute;
      left: 0.1rem;
      top: 0.56em;
      width: 0.42rem;
      height: 0.42rem;
      background: var(--tourney-accent);
      clip-path: polygon(0 0, 100% 50%, 0 100%);
      opacity: 0.75;
    }

    .ov-docs-params code {
      color: #a5f3fc;
      font-size: 0.78rem;
    }

    /* Endpoint rows (code directly followed by its description span). */
    .ov-docs-params li > code:first-child {
      margin-right: 0.55rem;
    }

    .ov-docs-preview {
      overflow: hidden;
      border: 1px solid var(--tourney-border);
      border-radius: 0.6rem;
      background: transparent;
    }

    .ov-docs-preview iframe {
      display: block;
      width: 100%;
      border: 0;
      background: transparent;
    }

    .ov-guide-lede {
      max-width: 62rem;
      margin: 0;
      font-size: 1.02rem;
      line-height: 1.65;
    }

    /* TourneyShell puts overflow-hidden on .tourney-page, which makes it a
       scroll container and silently disables sticky descendants. overflow:
       clip keeps the same visual clipping without creating one, so the rail
       follows the page. Scoped to this page only. */
    .tourney-page:has(.ov-guide-layout) {
      overflow: clip;
    }

    /* The global html, body { overflow-x: hidden } rule also turns body into
       a scroll container (overflow-y computes to auto), which hijacks the
       rail's sticky reference: body never scrolls, the viewport does, so the
       rail scrolls away. clip removes the scrolling mechanism while keeping
       the same visual clipping. Viewport scrolling still comes from html. */
    body:has(.ov-guide-layout) {
      overflow: clip;
    }

    .ov-guide-layout {
      display: grid;
      grid-template-columns: 180px minmax(0, 1fr);
      gap: 32px;
      align-items: start;
    }

    .ov-guide-rail {
      position: sticky;
      top: 90px;
      display: grid;
    }

    .ov-guide-rail a {
      display: flex;
      align-items: baseline;
      gap: 10px;
      border-bottom: 1px solid var(--tourney-border);
      color: var(--tourney-text-muted);
      font-size: 0.84rem;
      font-weight: 700;
      padding: 9px 0;
      text-decoration: none;
    }

    .ov-guide-rail a b {
      color: var(--tourney-accent);
      font-size: 0.68rem;
      font-weight: 820;
      letter-spacing: 0.08em;
    }

    .ov-guide-rail a:hover {
      color: var(--tourney-accent);
    }

    .ov-guide-main {
      display: grid;
      gap: 30px;
      min-width: 0;
    }

    @media (max-width: 900px) {
      .ov-guide-layout {
        grid-template-columns: minmax(0, 1fr);
      }

      .ov-guide-rail {
        display: none;
      }
    }

    .ov-figures {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 14px;
      margin: 6px 0 10px;
    }

    .ov-figure {
      margin: 0;
    }

    .ov-figure svg {
      display: block;
      width: 100%;
      height: auto;
      border: 1px solid var(--tourney-border);
      border-radius: 0.6rem;
      background: #14171b;
      font-family: inherit;
    }

    .ov-figure figcaption {
      margin-top: 8px;
      color: var(--tourney-text-muted);
      font-size: 0.84rem;
      line-height: 1.5;
    }

    .ov-guide-section {
      display: grid;
      gap: 12px;
      border-top: 1px solid var(--tourney-border);
      padding: 22px 0 4px;
      scroll-margin-top: 90px;
    }

    .ov-guide-section p {
      margin: 0;
      color: var(--tourney-text-soft);
      font-size: 0.92rem;
      line-height: 1.6;
    }

    .ov-guide-section h3 {
      margin: 0;
      font-size: 1.2rem;
    }

    .ov-guide-header {
      display: flex;
      align-items: baseline;
      gap: 14px;
    }

    .ov-guide-num {
      color: var(--tourney-accent);
      font-size: 1.5rem;
      font-weight: 820;
      letter-spacing: 0.04em;
      line-height: 1;
      opacity: 0.92;
    }

    .ov-guide-suggest {
      margin: 0;
      padding: 0;
      display: grid;
      gap: 8px;
      list-style: none;
      color: var(--tourney-text-soft);
      font-size: 0.88rem;
      line-height: 1.65;
    }

    .ov-guide-suggest li {
      position: relative;
      padding-left: 1.15rem;
    }

    .ov-guide-suggest li::before {
      content: "";
      position: absolute;
      left: 0.1rem;
      top: 0.58em;
      width: 0.42rem;
      height: 0.42rem;
      background: var(--tourney-accent);
      clip-path: polygon(0 0, 100% 50%, 0 100%);
    }

    .ov-guide-size {
      color: var(--tourney-text-muted);
      font-size: 0.85rem;
    }

    .ov-guide-size strong {
      color: var(--tourney-text);
      font-weight: 800;
      letter-spacing: 0.02em;
    }

    /* Collapsed depth (walkthrough, pin-a-match, quick fixes). Looks like a
       hairline-divided section row so it sits in the same rhythm as the open
       sections; the triangle rotates open. */
    .ov-guide-fold {
      border-top: 1px solid var(--tourney-border);
      padding: 16px 0 4px;
      scroll-margin-top: 90px;
    }

    .ov-guide-fold summary {
      cursor: pointer;
      display: flex;
      align-items: baseline;
      gap: 10px;
      list-style: none;
      color: var(--tourney-text);
      font-size: 1.05rem;
      font-weight: 700;
      line-height: 1.4;
    }

    .ov-guide-fold summary::-webkit-details-marker {
      display: none;
    }

    .ov-guide-fold summary::before {
      content: "";
      flex: none;
      align-self: center;
      width: 0.46rem;
      height: 0.46rem;
      background: var(--tourney-accent);
      clip-path: polygon(0 0, 100% 50%, 0 100%);
      opacity: 0.9;
      transition: transform 160ms ease;
    }

    .ov-guide-fold[open] summary::before {
      transform: rotate(90deg);
    }

    .ov-guide-fold summary:hover {
      color: var(--tourney-accent);
    }

    .ov-guide-fold[open] summary {
      margin-bottom: 12px;
    }

    .ov-guide-fold-body {
      display: grid;
      gap: 12px;
      padding: 0 0 14px;
    }

    .ov-guide-fold-body p {
      margin: 0;
      color: var(--tourney-text-soft);
      font-size: 0.92rem;
      line-height: 1.6;
    }

    /* A fold nested inside a section (the strip's pin-yours block) drops a
       step in the hierarchy. */
    .ov-guide-section .ov-guide-fold {
      border-top-color: transparent;
      padding-top: 4px;
    }

    .ov-guide-section .ov-guide-fold summary {
      font-size: 0.9rem;
      font-weight: 700;
      color: var(--tourney-text-muted);
    }

    .ov-caster {
      display: inline-block;
      padding: 10px;
      color: #fff;
      font-family: "Manrope Variable", system-ui, sans-serif;
    }

    .ov-caster[data-idle="true"] {
      padding: 0;
    }

    .ov-caster-card {
      position: relative;
      width: 1120px;
      overflow: hidden;
      border: 1px solid rgba(103, 232, 249, 0.42);
      border-radius: 18px;
      background:
        linear-gradient(90deg, rgba(2, 132, 199, 0.16), transparent 26%, transparent 74%, rgba(14, 165, 233, 0.16)),
        linear-gradient(180deg, rgba(6, 18, 38, 0.98), rgba(3, 11, 25, 0.96));
      box-shadow: inset 0 1px 0 rgba(207, 250, 254, 0.12),
        0 18px 44px rgba(2, 6, 23, 0.48),
        0 0 30px rgba(34, 211, 238, 0.14);
    }

    .ov-caster-card::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 50%;
      width: 1px;
      background: linear-gradient(transparent, rgba(103, 232, 249, 0.25), transparent);
    }

    .ov-caster-kicker {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 18px;
      border-bottom: 1px solid rgba(103, 232, 249, 0.16);
      color: rgba(165, 243, 252, 0.78);
      font-size: 0.68rem;
      font-weight: 800;
      letter-spacing: 0.14em;
      padding: 8px 18px;
      text-transform: uppercase;
    }

    .ov-caster-kicker span {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .ov-caster-kicker i {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--ov-live);
      box-shadow: 0 0 12px rgba(244, 63, 94, 0.8);
      animation: ov-pulse-dot 1.6s ease-out infinite;
    }

    .ov-caster-kicker b {
      color: #fff;
      text-align: center;
    }

    .ov-caster-kicker em {
      font-style: normal;
      text-align: right;
    }

    .ov-caster-scoreboard {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 270px minmax(0, 1fr);
      align-items: stretch;
      min-height: 96px;
    }

    .ov-caster-team {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 78px;
      align-items: center;
      gap: 16px;
      min-width: 0;
      padding: 15px 24px;
    }

    .ov-caster-team.is-a {
      text-align: right;
    }

    .ov-caster-team.is-b {
      grid-template-columns: 78px minmax(0, 1fr);
      background: linear-gradient(90deg, transparent, rgba(14, 165, 233, 0.09));
    }

    .ov-caster-team strong {
      overflow: hidden;
      font-size: 1.34rem;
      font-weight: 900;
      letter-spacing: -0.02em;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ov-caster-team span {
      display: grid;
      place-items: center;
      width: 68px;
      height: 58px;
      border: 1px solid rgba(103, 232, 249, 0.42);
      border-radius: 12px;
      background: rgba(8, 145, 178, 0.18);
      color: #e0f2fe;
      font-size: 2rem;
      font-weight: 900;
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }

    .ov-caster-map {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      border-inline: 1px solid rgba(103, 232, 249, 0.18);
      background: #020617;
      padding: 12px;
      text-align: center;
    }

    .ov-caster-map > img,
    .ov-caster-map > span {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }

    .ov-caster-map > img {
      object-fit: cover;
      object-position: center;
    }

    .ov-caster-map > span {
      background: linear-gradient(180deg, rgba(2, 6, 23, 0.58), rgba(2, 6, 23, 0.86));
    }

    .ov-caster-map small,
    .ov-caster-map b,
    .ov-caster-map em {
      position: relative;
      z-index: 1;
    }

    .ov-caster-map small,
    .ov-caster-map em {
      color: rgba(186, 230, 253, 0.9);
      font-size: 0.66rem;
      font-style: normal;
      font-weight: 800;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .ov-caster-map b {
      max-width: 100%;
      overflow: hidden;
      color: #cffafe;
      font-size: 1.15rem;
      font-weight: 900;
      text-overflow: ellipsis;
      text-shadow: 0 2px 12px rgba(0, 0, 0, 0.86);
      white-space: nowrap;
    }

    .ov-caster-bans {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 138px minmax(0, 1fr);
      align-items: stretch;
      min-height: 92px;
      border-top: 1px solid rgba(244, 63, 94, 0.28);
      background: rgba(30, 7, 16, 0.36);
    }

    .ov-caster-ban {
      display: grid;
      align-content: center;
      gap: 6px;
      min-width: 0;
      padding: 8px 14px 10px;
    }

    .ov-caster-ban.is-a {
      text-align: right;
    }

    .ov-caster-ban > small {
      overflow: hidden;
      color: rgba(254, 205, 211, 0.7);
      font-size: 0.58rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .ov-caster-ban-list {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }

    .ov-caster-ban.is-a .ov-caster-ban-list {
      justify-content: flex-end;
    }

    .ov-caster-ban-list > strong {
      color: rgba(254, 205, 211, 0.68);
      font-size: 0.76rem;
      text-transform: uppercase;
    }

    .ov-caster-ban-hero {
      position: relative;
      display: grid;
      flex: 0 1 58px;
      place-items: end center;
      width: 58px;
      min-width: 0;
      height: 62px;
      overflow: hidden;
      border: 1px solid rgba(251, 113, 133, 0.5);
      border-radius: 9px;
      background: linear-gradient(180deg, rgba(159, 18, 57, 0.22), rgba(30, 7, 16, 0.92));
    }

    .ov-caster-ban-hero img,
    .ov-caster-ban-hero i {
      position: absolute;
      inset: 0 0 15px;
      width: 100%;
      height: calc(100% - 15px);
    }

    .ov-caster-ban-hero img {
      object-fit: contain;
      object-position: center bottom;
    }

    .ov-caster-ban-hero i {
      display: grid;
      place-items: center;
      color: #fda4af;
      font-size: 1.8rem;
      font-style: normal;
    }

    .ov-caster-ban-hero b {
      position: relative;
      z-index: 1;
      width: 100%;
      overflow: hidden;
      background: rgba(76, 5, 25, 0.88);
      color: #fff1f2;
      font-size: 0.48rem;
      font-weight: 900;
      line-height: 15px;
      padding-inline: 3px;
      text-align: center;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .ov-caster-ban-title {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      border-inline: 1px solid rgba(244, 63, 94, 0.22);
      background: rgba(76, 5, 25, 0.2);
      text-align: center;
      text-transform: uppercase;
    }

    .ov-caster-ban-title small {
      color: rgba(254, 205, 211, 0.68);
      font-size: 0.62rem;
      font-weight: 800;
      letter-spacing: 0.12em;
    }

    .ov-caster-ban-title strong {
      color: #fff1f2;
      font-size: 0.82rem;
      letter-spacing: 0.08em;
    }

    html[data-theme="dark"] .ov-caster-card {
      border-color: rgba(255, 215, 110, 0.52);
      background:
        linear-gradient(90deg, rgba(255, 215, 110, 0.1), transparent 26%, transparent 74%, rgba(255, 215, 110, 0.1)),
        linear-gradient(180deg, rgba(11, 11, 11, 0.98), rgba(3, 3, 3, 0.97));
      box-shadow: inset 0 1px 0 rgba(255, 240, 189, 0.12),
        0 18px 44px rgba(0, 0, 0, 0.58),
        0 0 30px rgba(255, 215, 110, 0.14);
    }

    html[data-theme="dark"] .ov-caster-kicker,
    html[data-theme="dark"] .ov-caster-map,
    html[data-theme="dark"] .ov-caster-card::before {
      border-color: rgba(255, 215, 110, 0.26);
      color: rgba(255, 232, 163, 0.9);
    }

    html[data-theme="dark"] .ov-caster-kicker i {
      background: #ffd76e;
      box-shadow: 0 0 12px rgba(255, 215, 110, 0.74);
    }

    html[data-theme="dark"] .ov-caster-team.is-b {
      background: linear-gradient(90deg, transparent, rgba(255, 215, 110, 0.09));
    }

    html[data-theme="dark"] .ov-caster-team span {
      border-color: rgba(255, 215, 110, 0.44);
      background: rgba(255, 215, 110, 0.11);
      color: #fff0bd;
    }

    html[data-theme="dark"] .ov-caster-map {
      background: #050505;
    }

    html[data-theme="dark"] .ov-caster-map > img {
      filter: grayscale(1) sepia(0.72) brightness(0.58) contrast(1.12);
    }

    html[data-theme="dark"] .ov-caster-map > span {
      background: linear-gradient(180deg, rgba(5, 5, 5, 0.48), rgba(5, 5, 5, 0.9));
    }

    html[data-theme="dark"] .ov-caster-map small,
    html[data-theme="dark"] .ov-caster-map em {
      color: rgba(255, 232, 163, 0.84);
    }

    html[data-theme="dark"] .ov-caster-map b {
      color: #fff0bd;
    }

    html[data-theme="dark"] .ov-caster-bans {
      border-top-color: rgba(255, 215, 110, 0.3);
      background: rgba(9, 9, 9, 0.76);
    }

    html[data-theme="dark"] .ov-caster-ban > small,
    html[data-theme="dark"] .ov-caster-ban-list > strong,
    html[data-theme="dark"] .ov-caster-ban-title small {
      color: rgba(255, 232, 163, 0.74);
    }

    html[data-theme="dark"] .ov-caster-ban-hero {
      border-color: rgba(255, 215, 110, 0.48);
      background: linear-gradient(180deg, rgba(255, 215, 110, 0.15), rgba(5, 5, 5, 0.94));
    }

    html[data-theme="dark"] .ov-caster-ban-hero img {
      filter: grayscale(1) sepia(0.72) saturate(1.35);
    }

    html[data-theme="dark"] .ov-caster-ban-hero i {
      color: #ffe8a3;
    }

    html[data-theme="dark"] .ov-caster-ban-hero b {
      background: rgba(10, 10, 10, 0.94);
      color: #fff0bd;
    }

    html[data-theme="dark"] .ov-caster-ban-title {
      border-color: rgba(255, 215, 110, 0.26);
      background: rgba(15, 15, 15, 0.46);
    }

    html[data-theme="dark"] .ov-caster-ban-title strong {
      color: #fff0bd;
    }

    /* Blackout theme: the guide follows the site's gold palette. Borders
       already remap through --tourney-border-accent; these rules swap the
       hardcoded Roo Blue fills and text for dark gold tints. */
    html[data-theme="dark"] .tourney-page .ov-figure {
      --ov-figure-highlight: rgba(255, 215, 110, 0.18);
      --ov-figure-url: var(--tourney-accent-glow);
    }

    html[data-theme="dark"] .tourney-page .ov-docs-url code,
    html[data-theme="dark"] .tourney-page .ov-docs-params code {
      color: var(--tourney-accent-glow);
    }

    html[data-theme="dark"] .tourney-page .ov-docs-url button {
      background: rgba(255, 215, 110, 0.15);
      color: var(--tourney-accent-glow);
    }

    html[data-theme="dark"] .tourney-page .ov-docs-url button:hover {
      background: rgba(255, 215, 110, 0.26);
    }
  `}</style>
);
