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
      display: inline-block;
      padding: 14px;
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
  `}</style>
);
