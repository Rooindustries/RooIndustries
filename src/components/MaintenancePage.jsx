"use client";

import React from "react";

const MaintenancePage = () => {
  return (
    <>
      <style>{`
        .cs-page {
          --metal-1: #5a82a6;
          --metal-2: #486d8f;
          --metal-3: #355875;
          --metal-4: #25435d;
          --metal-5: #17304a;
          --metal-6: #0b1a2c;
          --text: #f2f7fb;
          --muted: rgba(225, 234, 242, 0.76);
          --accent: #59d8ff;
          min-height: 100vh;
          color: var(--text);
          font-family: "Manrope Variable", system-ui, sans-serif;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.14) 0%,
              rgba(255, 255, 255, 0.06) 12%,
              rgba(255, 255, 255, 0) 24%,
              rgba(255, 255, 255, 0.08) 36%,
              rgba(255, 255, 255, 0.02) 48%,
              rgba(0, 0, 0, 0.08) 62%,
              rgba(0, 0, 0, 0.16) 78%,
              rgba(0, 0, 0, 0.24) 100%
            ),
            linear-gradient(
              135deg,
              var(--metal-1) 0%,
              var(--metal-2) 14%,
              #6289ac 24%,
              var(--metal-3) 38%,
              #406482 48%,
              var(--metal-4) 60%,
              #1f3c55 72%,
              var(--metal-5) 86%,
              var(--metal-6) 100%
            );
        }

        .cs-shell {
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: max(28px, env(safe-area-inset-top)) 24px
            max(28px, env(safe-area-inset-bottom));
        }

        .cs-core {
          width: min(100%, 560px);
          text-align: center;
        }

        .cs-mark {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 156px;
          height: 156px;
          margin-bottom: 22px;
        }

        .cs-logo {
          width: 132px;
          height: 132px;
          object-fit: contain;
          border-radius: 24px;
        }

        .cs-brand {
          margin: 0;
          color: rgba(225, 234, 242, 0.86);
          font-size: 0.82rem;
          font-weight: 700;
          letter-spacing: 0.34em;
          text-transform: uppercase;
        }

        .cs-heading {
          margin: 18px 0 0;
          font-size: clamp(2.7rem, 9.6vw, 5rem);
          line-height: 0.96;
          letter-spacing: -0.045em;
          font-weight: 520;
        }

        .cs-subtitle {
          margin: 16px auto 0;
          max-width: none;
          color: var(--muted);
          font-size: clamp(1rem, 1.7vw, 1.16rem);
          line-height: 1.36;
          font-weight: 500;
          white-space: nowrap;
        }

        .cs-loading-dots {
          display: inline-grid;
          grid-auto-flow: column;
          gap: 0.02em;
          margin-left: 0.08em;
        }

        .cs-loading-dots span {
          animation: cs-dot 1.8s ease-in-out infinite;
        }

        .cs-loading-dots span:nth-child(2) {
          animation-delay: 0.24s;
        }

        .cs-loading-dots span:nth-child(3) {
          animation-delay: 0.48s;
        }

        .cs-actions {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 12px;
          margin-top: 28px;
        }

        .cs-button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 58px;
          min-width: min(100%, 220px);
          padding: 0 30px;
          border-radius: 999px;
          background: linear-gradient(180deg, #8ae8ff 0%, #59d8ff 100%);
          color: #05101d;
          text-decoration: none;
          font-size: 1rem;
          font-weight: 770;
          letter-spacing: -0.01em;
          box-shadow:
            0 18px 44px rgba(0, 0, 0, 0.34),
            inset 0 1px 0 rgba(255, 255, 255, 0.42);
          transition:
            transform 180ms ease,
            box-shadow 180ms ease,
            filter 180ms ease;
        }

        .cs-button-secondary {
          background: rgba(5, 16, 29, 0.36);
          border: 1px solid rgba(225, 234, 242, 0.22);
          color: var(--text);
          box-shadow:
            0 18px 44px rgba(0, 0, 0, 0.22),
            inset 0 1px 0 rgba(255, 255, 255, 0.12);
        }

        .cs-button:hover {
          transform: translateY(-1px);
          filter: saturate(1.04);
          box-shadow:
            0 22px 52px rgba(0, 0, 0, 0.42),
            inset 0 1px 0 rgba(255, 255, 255, 0.5);
        }

        .cs-note {
          margin: 14px 0 0;
          color: rgba(225, 234, 242, 0.58);
          font-size: 0.92rem;
          line-height: 1.45;
        }

        .cs-r1 {
          animation: cs-rise 0.88s cubic-bezier(0.16, 1, 0.3, 1) 0.06s both;
        }

        .cs-r2 {
          animation: cs-rise 0.88s cubic-bezier(0.16, 1, 0.3, 1) 0.16s both;
        }

        .cs-r3 {
          animation: cs-rise 0.88s cubic-bezier(0.16, 1, 0.3, 1) 0.28s both;
        }

        .cs-r4 {
          animation: cs-rise 0.88s cubic-bezier(0.16, 1, 0.3, 1) 0.4s both;
        }

        .cs-r5 {
          animation: cs-rise 0.88s cubic-bezier(0.16, 1, 0.3, 1) 0.52s both;
        }

        @keyframes cs-rise {
          from {
            opacity: 0;
            transform: translateY(14px);
          }

          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes cs-dot {
          0%,
          20%,
          100% {
            opacity: 0.28;
          }

          45% {
            opacity: 1;
          }
        }

        @media (max-width: 640px) {
          .cs-mark {
            width: 144px;
            height: 144px;
            margin-bottom: 18px;
          }

          .cs-logo {
            width: 120px;
            height: 120px;
          }

          .cs-brand {
            font-size: 0.74rem;
            letter-spacing: 0.26em;
          }

          .cs-subtitle {
            font-size: 0.84rem;
          }

          .cs-actions {
            margin-top: 24px;
          }

          .cs-button {
            width: 100%;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .cs-page *,
          .cs-page *::before,
          .cs-page *::after {
            animation: none !important;
            transition: none !important;
          }
        }
      `}</style>
      <main className="cs-page">
        <div className="cs-shell">
          <section className="cs-core">
            <div className="cs-mark cs-r1">
              <img
                className="cs-logo"
                src="/embed_logo.png"
                alt="Roo Industries"
                width="136"
                height="136"
              />
            </div>
            <p className="cs-brand cs-r2">Roo Industries</p>
            <h1 className="cs-heading cs-r3">Coming soon.</h1>
            <p className="cs-subtitle cs-r4">
              Performance Upgrades Loading
              <span className="cs-loading-dots" aria-hidden="true">
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>
            </p>
            <div className="cs-actions cs-r5">
              <a className="cs-button" href="https://www.rooindustries.com">
                Visit main site
              </a>
              <a
                className="cs-button cs-button-secondary"
                href="https://discord.com/invite/qs5HKNyazD"
                target="_blank"
                rel="noreferrer"
              >
                Join Discord
              </a>
            </div>
            <p className="cs-note cs-r5">
              Release updates will land in Discord first.
            </p>
          </section>
        </div>
      </main>
    </>
  );
};

export default MaintenancePage;
