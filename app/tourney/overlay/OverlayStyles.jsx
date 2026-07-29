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

    .ov-demo-bg {
      min-height: 100vh;
      background-image: linear-gradient(
        to top,
        #00b7c0 0%,
        #006185 30%,
        #001f5a 65%,
        #000040 100%
      );
    }

    .ov-bracket {
      display: flex;
      align-items: safe center;
      justify-content: center;
      box-sizing: border-box;
      min-height: 100vh;
      padding: 8px;
    }

    .ov-bracket-fit {
      flex: 0 0 auto;
      text-align: left;
    }

    /* The source auto-fits the whole tree into the browser-source viewport,
       so the board renders at natural content size with no clipping or
       scrollbars; the JS zoom then scales it onto the frame. The finals rail
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
      padding: 1px 6px;
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

    .ov-docs-card {
      border: 1px solid var(--tourney-border);
      border-radius: 0.85rem;
      background: var(--tourney-surface);
      padding: 16px;
    }

    .ov-docs-card h3 {
      margin: 0 0 6px;
      font-size: 1.05rem;
    }

    .ov-docs-card p {
      margin: 0 0 12px;
      color: var(--tourney-text-soft);
      font-size: 0.9rem;
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
      padding-left: 1.1rem;
      color: var(--tourney-text-muted);
      font-size: 0.82rem;
      line-height: 1.6;
    }

    .ov-docs-params code {
      color: #a5f3fc;
      font-size: 0.78rem;
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

    .ov-guide-toc {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .ov-guide-toc a {
      border: 1px solid var(--tourney-border);
      border-radius: 999px;
      background: var(--tourney-surface);
      color: var(--tourney-text-soft);
      font-size: 0.82rem;
      font-weight: 700;
      padding: 7px 14px;
      text-decoration: none;
    }

    .ov-guide-toc a:hover {
      border-color: var(--tourney-border-accent);
      color: #cffafe;
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
      border: 1px solid var(--tourney-border);
      border-radius: 0.85rem;
      background: var(--tourney-surface);
      padding: 18px;
      scroll-margin-top: 90px;
    }

    .ov-guide-section p {
      margin: 0;
      color: var(--tourney-text-soft);
      font-size: 0.92rem;
      line-height: 1.6;
    }

    .ov-guide-section h4 {
      margin: 6px 0 -4px;
      color: var(--tourney-text-muted);
      font-size: 0.78rem;
      font-weight: 800;
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }

    .ov-guide-header {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .ov-guide-header h3 {
      margin: 0;
      font-size: 1.12rem;
    }

    .ov-guide-step {
      flex: 0 0 auto;
      border: 1px solid var(--tourney-border-accent);
      border-radius: 999px;
      background: rgba(8, 145, 178, 0.2);
      color: #a5f3fc;
      font-size: 0.68rem;
      font-weight: 800;
      letter-spacing: 0.1em;
      padding: 4px 10px;
      text-transform: uppercase;
    }

    .ov-guide-steps {
      margin: 0;
      padding-left: 1.3rem;
      color: var(--tourney-text-soft);
      font-size: 0.9rem;
      line-height: 1.7;
      list-style: decimal outside;
    }

    .ov-guide-steps li + li {
      margin-top: 2px;
    }

    .ov-guide-suggest {
      margin: 0;
      padding: 12px 14px 12px 16px;
      border-left: 3px solid var(--tourney-border-accent);
      border-radius: 0 0.5rem 0.5rem 0;
      background: rgba(8, 145, 178, 0.1);
      color: var(--tourney-text-soft);
      font-size: 0.88rem;
      line-height: 1.65;
      list-style: disc;
      padding-left: 2rem;
    }

    .ov-guide-suggest li + li {
      margin-top: 6px;
    }

    .ov-guide-quickref summary {
      cursor: pointer;
      font-size: 1.05rem;
      font-weight: 700;
    }

    .ov-guide-quickref[open] summary {
      margin-bottom: 14px;
    }

    .ov-guide-quickref .ov-docs-card {
      margin-top: 12px;
    }

    /* Blackout theme: the guide follows the site's gold palette. Borders
       already remap through --tourney-border-accent; these rules swap the
       hardcoded Roo Blue fills and text for dark gold tints. */
    html[data-theme="dark"] .tourney-page .ov-figure {
      --ov-figure-highlight: rgba(240, 195, 90, 0.16);
      --ov-figure-url: var(--tourney-accent-glow);
    }

    html[data-theme="dark"] .tourney-page .ov-docs-url code,
    html[data-theme="dark"] .tourney-page .ov-docs-params code {
      color: var(--tourney-accent-glow);
    }

    html[data-theme="dark"] .tourney-page .ov-docs-url button {
      background: rgba(240, 195, 90, 0.14);
      color: var(--tourney-accent-glow);
    }

    html[data-theme="dark"] .tourney-page .ov-docs-url button:hover {
      background: rgba(240, 195, 90, 0.24);
    }

    html[data-theme="dark"] .tourney-page .ov-guide-step {
      background: rgba(240, 195, 90, 0.12);
      color: var(--tourney-accent-glow);
    }

    html[data-theme="dark"] .tourney-page .ov-guide-toc a:hover {
      color: var(--tourney-accent-glow);
    }

    html[data-theme="dark"] .tourney-page .ov-guide-suggest {
      background: rgba(240, 195, 90, 0.06);
    }
  `}</style>
);
