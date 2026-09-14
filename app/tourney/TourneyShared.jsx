import TourneyFooter from "./TourneyFooter";
import TourneyThemeToggle from "./TourneyThemeToggle";

export const Section = ({ id, eyebrow, title, children, wide = false }) => (
  <section
    id={id}
    className={wide ? "tourney-section tourney-section-wide" : "tourney-section"}
    aria-labelledby={`${id}-title`}
  >
    <p className="tourney-eyebrow">{eyebrow}</p>
    <h2 id={`${id}-title`}>{title}</h2>
    <div className="tourney-section-body">{children}</div>
  </section>
);

const TourneyStyles = () => (
  <style>{`
    .tourney-page {
      --tourney-nav-offset: 5rem;
      --tourney-text: #ffffff;
      --tourney-text-soft: rgba(226, 232, 240, 0.86);
      --tourney-text-muted: rgba(148, 163, 184, 0.86);
      --tourney-surface: rgba(10, 19, 36, 0.72);
      --tourney-surface-strong: rgba(6, 18, 38, 0.95);
      --tourney-surface-soft: rgba(255, 255, 255, 0.05);
      --tourney-border: rgba(255, 255, 255, 0.1);
      --tourney-border-accent: rgba(103, 232, 249, 0.3);
      --tourney-accent: #22d3ee;
      --tourney-accent-strong: #0284c7;
      --tourney-accent-glow: #03e9f4;
      --tourney-accent-soft: rgba(103, 232, 249, 0.5);
      --tourney-focus: rgba(103, 232, 249, 0.7);
      --tourney-card-shadow: inset 0 1px 0 rgba(186, 230, 253, 0.08),
        0 12px 30px rgba(2, 6, 23, 0.28);
      min-height: 100vh;
      color: var(--tourney-text);
      background-image: linear-gradient(
        to top,
        #00b7c0 0%,
        #006185 30%,
        #001f5a 65%,
        #000040 100%
      );
      font-family: "Manrope Variable", system-ui, sans-serif;
    }

    .tourney-shell {
      position: relative;
      z-index: 10;
      width: min(100%, 80rem);
      margin: 0 auto;
      padding: calc(var(--tourney-nav-offset) + 0.25rem) 1rem 5rem;
    }

    .tourney-nav {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 50;
      isolation: isolate;
      overflow: visible;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      background-image:
        linear-gradient(180deg, rgba(7, 22, 45, 0.88), rgba(6, 18, 38, 0.72)),
        radial-gradient(circle at top center, rgba(34, 211, 238, 0.08), transparent 58%);
      box-shadow:
        inset 0 1px 0 rgba(186, 230, 253, 0.08),
        0 12px 30px rgba(2, 6, 23, 0.28);
      backdrop-filter: saturate(135%) blur(14px);
      -webkit-backdrop-filter: saturate(135%) blur(14px);
    }

    .tourney-nav-grid {
      position: absolute;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      opacity: 0.14;
      background-image:
        linear-gradient(to right, rgba(255,255,255,0.08) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255,255,255,0.06) 1px, transparent 1px);
      background-size: 80px 80px;
    }

    .tourney-nav-line {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 0;
      height: 1px;
      pointer-events: none;
      background: linear-gradient(to right, transparent, rgba(103, 232, 249, 0.5), transparent);
    }

    .tourney-nav-inner {
      position: relative;
      z-index: 10;
      max-width: 80rem;
      margin: 0 auto;
      padding: 0 1rem;
    }

    .tourney-nav-row {
      display: flex;
      align-items: center;
      min-height: 5rem;
      overflow: visible;
    }

    .tourney-brand {
      display: flex;
      align-items: center;
      gap: 12px;
      color: #fff;
      text-decoration: none;
      user-select: none;
    }

    .tourney-brand-logo {
      position: relative;
      display: grid;
      place-items: center;
      width: 56px;
      height: 56px;
      overflow: hidden;
      border-radius: 0.75rem;
    }

    .tourney-brand-logo img {
      width: 56px;
      height: 56px;
      object-fit: contain;
      filter: drop-shadow(0 0 18px rgba(34,211,238,0.25));
    }

    .tourney-brand strong {
      display: block;
      color: #fff;
      font-size: 1.125rem;
      line-height: 1.1;
      font-weight: 600;
      letter-spacing: 0;
    }

    .tourney-brand-copy span {
      display: block;
      margin-top: 3px;
      color: rgba(255, 255, 255, 0.55);
      font-size: 0.75rem;
      line-height: 1.2;
      letter-spacing: 0;
      white-space: nowrap;
    }

    .tourney-links {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      min-width: 0;
      margin-left: auto;
    }

    .tourney-links a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 2.5rem;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 9999px;
      color: rgba(255, 255, 255, 0.85);
      background: transparent;
      padding: 0 1.25rem;
      font-size: 1rem;
      font-weight: 500;
      line-height: 1;
      text-decoration: none;
      transition: border-color 200ms ease, color 200ms ease, background 200ms ease;
    }

    .tourney-links a:hover {
      border-color: rgba(103, 232, 249, 0.3);
      color: #a5f3fc;
      background: rgba(255, 255, 255, 0.05);
    }

    .tourney-theme-switch {
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;
      margin-left: 0.75rem;
      outline: none;
    }

    .tourney-theme-switch:focus-visible {
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--tourney-focus) 42%, transparent);
    }

    .tourney-sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      clip-path: inset(50%);
    }

    .tourney-hero {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      max-width: 56rem;
      margin: 0 auto;
      min-height: clamp(19rem, 36vw, 24rem);
      padding: 1.75rem 0 2.5rem;
      text-align: center;
    }

    .tourney-hero h1 {
      margin: 0;
      width: 100%;
      color: #fff;
      font-size: var(--hero-line1-size);
      line-height: 1.08;
      font-weight: 800;
      letter-spacing: 0;
    }

    .tourney-title-line {
      display: block;
      width: 100%;
      text-align: center;
      overflow: visible;
    }

    .tourney-hero p {
      margin: 1rem auto 0;
      max-width: 42rem;
      color: rgba(226, 232, 240, 0.9);
      font-size: clamp(0.875rem, 0.75rem + 0.55vw, 1.125rem);
      line-height: 1.625;
      font-weight: 500;
    }

    .tourney-registration-status {
      display: inline-grid;
      grid-template-columns: auto auto;
      align-items: center;
      gap: 0.35rem 0.8rem;
      margin-top: 1.35rem;
      border: 1px solid rgba(251, 146, 60, 0.42);
      border-radius: 9999px;
      color: rgba(255, 255, 255, 0.94);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.035)),
        rgba(67, 20, 7, 0.48);
      padding: 0.72rem 1.15rem;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.12),
        0 12px 28px rgba(2, 6, 23, 0.2);
      backdrop-filter: blur(24px) saturate(150%);
      -webkit-backdrop-filter: blur(24px) saturate(150%);
    }

    .tourney-registration-status strong {
      color: #fed7aa;
      font-size: 0.78rem;
      font-weight: 860;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .tourney-registration-status span {
      color: rgba(255, 237, 213, 0.9);
      font-size: 0.88rem;
      font-weight: 700;
    }

    .tourney-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.625rem;
      min-height: 2.25rem;
      margin-bottom: 1.25rem;
      border: 1px solid rgba(34, 211, 238, 0.4);
      border-radius: 9999px;
      padding: 0 1.25rem;
      color: #ecfeff;
      background: rgba(15, 23, 42, 0.9);
      box-shadow: 0 0 18px rgba(56, 189, 248, 0.7);
      font-size: 0.95rem;
      font-weight: 700;
      letter-spacing: 0;
    }

    .tourney-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1.125rem;
    }

    .tourney-section {
      scroll-margin-top: calc(var(--tourney-nav-offset) + 1rem);
      border: 1px solid rgba(14, 165, 233, 0.3);
      border-radius: 1rem;
      background: rgba(11, 17, 32, 0.8);
      padding: 1.75rem;
      text-align: center;
      box-shadow: 0 0 25px rgba(14, 165, 233, 0.15);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }

    .tourney-section-wide {
      grid-column: 1 / -1;
    }

    .tourney-section h2 {
      margin: 0 auto;
      color: #fff;
      font-size: 1.72rem;
      line-height: 1.16;
      font-weight: 780;
      letter-spacing: 0;
      text-align: center;
    }

    .tourney-eyebrow {
      margin: 0 0 10px;
      color: #7dd3fc;
      font-size: 0.74rem;
      font-weight: 820;
      line-height: 1.2;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .tourney-section-body {
      margin-top: 18px;
      color: rgba(203, 213, 225, 0.9);
      font-size: 0.98rem;
      line-height: 1.62;
      text-align: left;
    }

    .tourney-section-body ul {
      display: grid;
      gap: 10px;
      margin: 0;
      padding-left: 20px;
    }

    .tourney-page .app-bg-grid-layer {
      background-image:
        linear-gradient(45deg, var(--color-grid-line) 1px, transparent 1px);
      background-size: 40px 40px;
      opacity: var(--app-grid-opacity);
    }

    .tourney-page .app-bg-radial-layer {
      background-image: radial-gradient(
        circle at center,
        rgba(14, 165, 233, 0.16),
        rgba(0, 31, 90, 0.12) 42%,
        transparent 74%
      );
    }

    .tourney-nav {
      border-color: var(--tourney-border);
      background: var(--gradient-glass);
      box-shadow: var(--highlight-glass-top), var(--shadow-navbar-scrolled);
    }

    .tourney-nav-line {
      background: linear-gradient(
        to right,
        transparent,
        var(--tourney-accent-soft),
        transparent
      );
    }

    .tourney-brand-logo img {
      filter: drop-shadow(0 0 18px color-mix(in srgb, var(--tourney-accent-glow) 26%, transparent));
    }

    .tourney-brand,
    .tourney-brand strong,
    .tourney-hero h1,
    .tourney-section h2 {
      color: var(--tourney-text);
    }

    .tourney-brand-copy span,
    .tourney-hero p,
    .tourney-section-body {
      color: var(--tourney-text-soft);
    }

    .tourney-eyebrow {
      color: var(--tourney-accent);
    }

    .tourney-links a,
    .tourney-theme-switch .theme-switch-track,
    .tourney-badge {
      border-color: var(--tourney-border);
      color: var(--tourney-text-soft);
      background: var(--tourney-surface-soft);
      box-shadow: none;
    }

    .tourney-links a:hover,
    .tourney-theme-switch:hover .theme-switch-track {
      border-color: var(--tourney-border-accent);
      color: var(--tourney-accent);
      background: var(--color-surface-hover-accent);
    }

    .tourney-section {
      border-color: var(--tourney-border-accent);
      background:
        linear-gradient(145deg, var(--tourney-surface), var(--tourney-surface-strong));
      box-shadow: var(--tourney-card-shadow);
    }

    .tourney-footer {
      color: var(--tourney-text-soft);
    }

    .tourney-footer-surface {
      border-top: 1px solid var(--tourney-border);
      background:
        var(--gradient-glass-lite),
        linear-gradient(180deg, var(--tourney-surface-strong), var(--color-surface-solid));
      box-shadow:
        var(--highlight-glass-top),
        0 -20px 50px rgba(0, 0, 0, 0.18);
    }

    .tourney-footer-divider {
      border-color: var(--tourney-border);
    }

    .tourney-footer-logo {
      filter: drop-shadow(0 0 14px color-mix(in srgb, var(--tourney-accent-glow) 30%, transparent));
    }

    .tourney-footer-link,
    .tourney-footer-muted,
    .tourney-footer-top {
      color: var(--tourney-text-muted);
    }

    .tourney-footer-subtle {
      color: color-mix(in srgb, var(--tourney-text-muted) 72%, transparent);
    }

    .tourney-footer-link:hover,
    .tourney-footer-credit-link,
    .tourney-footer-top:hover,
    .tourney-footer-top-arrow {
      color: var(--tourney-accent);
    }

    .tourney-footer-credit-link:hover {
      color: var(--tourney-accent-strong);
    }

    .tourney-footer-discord {
      border-color: var(--tourney-border-accent);
      color: var(--tourney-text);
      background: var(--color-surface-hover-accent);
      box-shadow: 0 0 18px color-mix(in srgb, var(--tourney-accent-glow) 18%, transparent);
    }

    .tourney-footer-discord:hover {
      border-color: var(--tourney-focus);
      color: var(--tourney-accent);
      background: color-mix(in srgb, var(--color-surface-hover-accent) 70%, var(--tourney-surface-soft));
    }

    .tourney-footer-payments,
    .tourney-footer-payment-card {
      border-color: var(--tourney-border);
      background: var(--tourney-surface-soft);
    }

    html[data-theme="dark"] .tourney-page {
      --tourney-text: var(--color-text-primary);
      --tourney-text-soft: var(--color-text-secondary);
      --tourney-text-muted: #a3a3a0;
      --tourney-surface: var(--color-surface-card);
      --tourney-surface-strong: var(--color-surface-solid);
      --tourney-surface-soft: var(--color-surface-hover);
      --tourney-border: var(--color-border-soft);
      --tourney-border-accent: var(--color-border-accent);
      --tourney-accent: var(--color-accent);
      --tourney-accent-strong: var(--color-accent-strong);
      --tourney-accent-glow: var(--color-accent-glow);
      --tourney-accent-soft: var(--color-accent-soft);
      --tourney-focus: var(--color-focus-ring);
      --tourney-card-shadow: var(--highlight-glass-top), var(--shadow-surface);
    }

    html[data-theme="dark"] .tourney-page {
      background-image: var(--gradient-app-bg);
    }

    html[data-theme="dark"] .tourney-page .app-bg-radial-layer {
      background-image: var(--gradient-app-radial);
    }

    html[data-theme="dark"] .tourney-nav-grid {
      opacity: 0.08;
    }

    html[data-theme="dark"] .tourney-badge,
    html[data-theme="dark"] .tourney-eyebrow {
      text-shadow: 0 0 10px rgba(255, 215, 110, 0.18);
    }

    @media (max-width: 980px) {
      .tourney-page {
        --tourney-nav-offset: 8.25rem;
      }

      .tourney-nav-row {
        align-items: flex-start;
        flex-wrap: wrap;
        gap: 0.75rem;
        min-height: 0;
        padding: 0.75rem 0;
      }

      .tourney-links {
        order: 3;
        flex-basis: 100%;
        justify-content: flex-start;
        overflow-x: auto;
        padding-bottom: 3px;
        margin-left: 0;
      }

      .tourney-hero {
        grid-template-columns: 1fr;
        min-height: 18rem;
      }

      .tourney-hero h1 {
        font-size: 3rem;
      }

      .tourney-grid {
        grid-template-columns: 1fr;
      }

      .tourney-section-wide {
        grid-column: auto;
      }
    }

    @media (max-width: 640px) {
      .tourney-page {
        --tourney-nav-offset: 5rem;
      }

      .tourney-shell {
        padding-inline: 0.875rem;
      }

      .tourney-nav-row {
        align-items: center;
        flex-wrap: nowrap;
        gap: 0.625rem;
        min-height: 4.5rem;
        padding: 0;
      }

      .tourney-nav-inner {
        padding-inline: 0.875rem;
      }

      .tourney-brand {
        min-width: 0;
      }

      .tourney-brand-logo {
        width: 48px;
        height: 48px;
      }

      .tourney-brand-logo img {
        width: 48px;
        height: 48px;
      }

      .tourney-brand-copy {
        display: none;
      }

      .tourney-links {
        display: none;
      }

      .tourney-theme-switch {
        order: 3;
        margin-left: auto;
      }

      .tourney-hero {
        min-height: 16rem;
        padding: 1.5rem 0 2rem;
      }

      .tourney-hero h1 {
        font-size: 2.28rem;
      }

      .tourney-registration-status {
        grid-template-columns: 1fr;
        width: min(100%, 17rem);
        margin-inline: auto;
      }

      .tourney-section {
        padding: 22px;
      }
    }

    html.low-performance-mode .tourney-page,
    html.low-performance-mode #app-shell.tourney-page.is-performance-mode,
    .tourney-page.is-performance-mode {
      background-attachment: scroll !important;
    }

    .tourney-page.is-performance-mode {
      overflow: visible;
    }

    html.low-performance-mode .tourney-nav,
    .tourney-page.is-performance-mode .tourney-nav {
      -webkit-backdrop-filter: none !important;
      backdrop-filter: none !important;
      background-image: none !important;
      background-color: var(--tourney-surface-strong) !important;
      box-shadow: var(--highlight-glass-top) !important;
      isolation: auto !important;
    }

    html.low-performance-mode .app-bg-grid-layer,
    html.low-performance-mode .app-bg-radial-layer,
    .tourney-page.is-performance-mode .app-bg-grid-layer,
    .tourney-page.is-performance-mode .app-bg-radial-layer {
      display: none !important;
    }

    .tourney-page.is-performance-mode .tourney-registration-status,
    .tourney-page.is-performance-mode .tourney-section {
      -webkit-backdrop-filter: none !important;
      backdrop-filter: none !important;
    }

    .tourney-page.is-performance-mode .tourney-brand-logo img {
      filter: none !important;
      text-shadow: none !important;
    }

    html.low-performance-mode .tourney-brand-logo img {
      filter: none !important;
      text-shadow: none !important;
      box-shadow: none !important;
    }
  `}</style>
);

const TourneyNav = () => (
  <header className="tourney-nav">
    <div className="tourney-nav-grid" aria-hidden="true" />
    <div className="tourney-nav-line" aria-hidden="true" />
    <div className="tourney-nav-inner">
      <div className="tourney-nav-row">
        <a className="tourney-brand" href="/" aria-label="Roo Industries home">
          <span className="tourney-brand-logo">
            <img src="/favicon-96x96.png" alt="" width="56" height="56" />
          </span>
          <span className="tourney-brand-copy">
            <strong>Roo Industries</strong>
            <span>6v6 Legacy Series</span>
          </span>
        </a>
        <nav className="tourney-links tourney-conversion-nav" aria-label="PC optimization">
          <a className="nav-cta" href="/#packages">Get your PC Optimized</a>
        </nav>
        <TourneyThemeToggle />
      </div>
    </div>
  </header>
);

export const TourneyShell = ({ children }) => (
  <>
    <TourneyStyles />
    <div
      id="app-shell"
      className="tourney-page relative min-h-screen flex flex-col overflow-hidden bg-scroll is-performance-mode"
    >
      <div className="app-bg-grid-layer absolute inset-0" />
      <div className="app-bg-radial-layer absolute inset-0" />
      <TourneyNav />
      <main
        id="main-content"
        data-tourney-state="results"
        tabIndex={-1}
        className="relative z-10 flex flex-col flex-1"
      >
        <div className="tourney-shell">
          {children}
        </div>
        <TourneyFooter />
      </main>
    </div>
  </>
);
