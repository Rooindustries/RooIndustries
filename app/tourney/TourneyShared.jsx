import { cookies } from "next/headers";
import TourneyFooter from "./TourneyFooter";
import TourneyTelemetry from "./TourneyTelemetry";
import TourneyThemeToggle from "./TourneyThemeToggle";
import {
  TOURNEY_SESSION_COOKIE,
  readTourneySessionFromStore,
} from "../../src/server/tourney/auth";
import { isTourneyAdminSession } from "../../src/server/tourney/access";
import {
  extractTwitchLogin,
  getTwitchLiveStatusMap,
} from "../../src/server/tourney/twitch";

export const navItems = [
  { href: "/tourney#info", label: "Event Information" },
  { href: "/tourney#rules", label: "Rules" },
  { href: "/tourney/roster", label: "Roster" },
  { href: "/tourney/bracket", label: "Bracket" },
];

export const getNavItems = (session) => {
  return isTourneyAdminSession(session)
    ? [...navItems, { href: "/tourney/manage", label: "Manage" }]
    : navItems;
};

export const getTourneySession = async () => {
  const cookieStore = await cookies();
  const token = cookieStore.get(TOURNEY_SESSION_COOKIE)?.value || "";
  return readTourneySessionFromStore({ token });
};

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

export const StatusPanel = ({ label = "Reserved", title, children }) => (
  <div className="tourney-status-panel" aria-label={title}>
    <p className="tourney-kicker">{label}</p>
    <h3>{title}</h3>
    <p>{children}</p>
  </div>
);

export const tourneyHosts = [
  {
    name: "Yukari",
    role: "Host",
    image: "/tourney/hosts/yukari.png",
    avatarFit: "contain",
    twitchUrl: "https://www.twitch.tv/yukaripoi",
    twitchLabel: "yukaripoi",
  },
  {
    name: "Serviroo",
    role: "Tournament Director",
    image: "/tourney/hosts/serviroo.png",
    twitchUrl: "",
    twitchLabel: "",
    featured: true,
  },
  {
    name: "Supa",
    role: "Host",
    image: "/tourney/hosts/supa.png",
    twitchUrl: "https://twitch.tv/supa_ow",
    twitchLabel: "supa_ow",
  },
];

const getHostTwitchLogin = (host = {}) =>
  extractTwitchLogin(host.twitchUrl || host.twitchLabel);

const attachLiveStatusToHost = (host, liveStatusMap) => {
  const twitchLogin = getHostTwitchLogin(host);
  const liveStatus = twitchLogin ? liveStatusMap.get(twitchLogin) : null;

  return {
    ...host,
    twitchLogin,
    ...(liveStatus?.isLive
      ? {
          twitchLive: true,
          twitchLiveTitle: liveStatus.title,
          twitchLiveGameName: liveStatus.gameName,
          twitchLiveViewerCount: liveStatus.viewerCount,
          twitchLiveStartedAt: liveStatus.startedAt,
        }
      : {}),
  };
};

export const getTourneyHostsWithLiveStatus = async ({
  env = process.env,
} = {}) => {
  const twitchLogins = tourneyHosts.map(getHostTwitchLogin).filter(Boolean);
  const liveStatusMap = await getTwitchLiveStatusMap(twitchLogins, {
    env,
  }).catch(() => new Map());

  if (!liveStatusMap.size) return tourneyHosts;
  return tourneyHosts.map((host) => attachLiveStatusToHost(host, liveStatusMap));
};

export const TourneyTwitchIcon = () => (
  <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
    <path
      d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"
      fill="currentColor"
    />
  </svg>
);

const TourneyLiveBadge = ({ name, title = "" }) => (
  <span
    aria-label={`${name} is live on Twitch`}
    className="tourney-roster-live-badge"
    title={title || `${name} is live on Twitch`}
  >
    <span aria-hidden="true" />
    Live
  </span>
);

const HostCard = ({ host }) => (
  <article
    className={[
      "tourney-host-card",
      host.featured ? "is-featured" : "",
      host.twitchLive ? "is-live" : "",
    ]
      .filter(Boolean)
      .join(" ")}
  >
    <span
      className={
        host.avatarFit === "contain"
          ? "tourney-host-avatar is-contained"
          : "tourney-host-avatar"
      }
    >
      <img src={host.image} alt={`${host.name} logo`} />
    </span>
    <span className="tourney-host-copy">
      <span
        className={
          host.twitchLive
            ? "tourney-host-name-line has-live"
            : "tourney-host-name-line"
        }
      >
        <strong>{host.name}</strong>
        {host.twitchLive ? (
          <TourneyLiveBadge name={host.name} title={host.twitchLiveTitle} />
        ) : null}
      </span>
      <span className="tourney-host-role">{host.role}</span>
    </span>
    {host.twitchUrl ? (
      <a
        className="tourney-host-twitch"
        href={host.twitchUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        <TourneyTwitchIcon />
        <span>{host.twitchLabel}</span>
      </a>
    ) : null}
  </article>
);

export const TourneyHosts = ({ variant = "front", hosts = tourneyHosts }) => {
  const director = hosts.find((host) => host.featured);
  const hostCards = hosts.filter((host) => !host.featured);

  if (variant === "roster") {
    return (
      <section
        aria-labelledby="tourney-hosts-title"
        className="tourney-host-showcase is-roster"
      >
        <div className="tourney-host-head">
          <p className="tourney-eyebrow">Tournament Team</p>
          <h2 id="tourney-hosts-title">Hosts</h2>
        </div>
        <div className="tourney-host-director">
          <HostCard host={director} />
        </div>
        <div className="tourney-host-grid">
          {hostCards.map((host) => (
            <HostCard host={host} key={host.name} />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="tourney-hosts-title"
      className="tourney-host-showcase"
    >
      <div className="tourney-host-head">
        <p className="tourney-eyebrow">Tournament Team</p>
        <h2 id="tourney-hosts-title">Hosts</h2>
      </div>
      <div className="tourney-host-grid">
        {hosts.map((host) => (
          <HostCard host={host} key={host.name} />
        ))}
      </div>
    </section>
  );
};

export const TourneyRosterHosts = ({ hosts = tourneyHosts }) => (
  <ul className="tourney-roster-list tourney-roster-host-list">
    {[...hosts]
      .sort(
        (first, second) =>
          Number(Boolean(second.featured)) - Number(Boolean(first.featured))
      )
      .map((host) => (
        <li
          className={
            [
              "tourney-roster-player",
              "tourney-roster-host-row",
              host.featured ? "is-featured" : "",
              host.twitchLive ? "is-live" : "",
            ]
              .filter(Boolean)
              .join(" ")
          }
          key={host.name}
        >
          <span className="tourney-roster-identity">
            <span
              aria-hidden="true"
              className={
                host.avatarFit === "contain"
                  ? "tourney-roster-avatar is-contained"
                  : "tourney-roster-avatar"
              }
            >
              <img alt="" loading="lazy" src={host.image} />
            </span>
            <span className="tourney-roster-name-copy">
              <strong
                className={
                  host.twitchLive
                    ? "tourney-roster-name-line has-live"
                    : "tourney-roster-name-line"
                }
              >
                <span className="tourney-roster-player-name">{host.name}</span>
                {host.twitchLive ? (
                  <TourneyLiveBadge
                    name={host.name}
                    title={host.twitchLiveTitle}
                  />
                ) : null}
              </strong>
              <span className="tourney-roster-label">{host.role}</span>
            </span>
          </span>
          <span className="tourney-roster-detail">
            <strong>{host.featured ? "Director" : "Host"}</strong>
            <span className="tourney-roster-label">Event role</span>
          </span>
          <span className="tourney-roster-detail">
            <strong>Roo Industries</strong>
            <span className="tourney-roster-label">Tournament team</span>
          </span>
          <span
            aria-hidden={host.twitchUrl ? undefined : true}
            className="tourney-roster-cta"
          >
            {host.twitchUrl ? (
              <a href={host.twitchUrl} rel="noopener noreferrer" target="_blank">
                <TourneyTwitchIcon />
                <span>{host.twitchLabel}</span>
              </a>
            ) : null}
          </span>
        </li>
      ))}
  </ul>
);

export const TourneyStyles = () => (
  <style>{`
    .tourney-page {
      --tourney-nav-offset: 5rem;
      --tourney-mobile-nav-height: 5rem;
      --tourney-text: #ffffff;
      --tourney-text-soft: rgba(226, 232, 240, 0.86);
      --tourney-text-muted: rgba(148, 163, 184, 0.86);
      --tourney-surface: rgba(10, 19, 36, 0.72);
      --tourney-surface-strong: rgba(6, 18, 38, 0.95);
      --tourney-surface-soft: rgba(255, 255, 255, 0.05);
      --tourney-input: #0c162a;
      --tourney-border: rgba(255, 255, 255, 0.1);
      --tourney-border-strong: rgba(148, 163, 184, 0.45);
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

    .tourney-shell.is-wide {
      width: min(100%, 96rem);
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

    .tourney-links a,
    .tourney-login-link,
    .tourney-logout {
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

    .tourney-links a:hover,
    .tourney-links a.is-active,
    .tourney-login-link:hover,
    .tourney-logout:hover {
      border-color: rgba(103, 232, 249, 0.3);
      color: #a5f3fc;
      background: rgba(255, 255, 255, 0.05);
    }

    .tourney-session {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-left: 0.75rem;
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

    .tourney-mobile-menu {
      display: none;
    }

    .tourney-mobile-trigger {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.5rem;
      height: 2.5rem;
      border: 1px solid rgba(125, 211, 252, 0.2);
      border-radius: 9999px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02)),
        rgba(7, 22, 45, 0.52);
      cursor: pointer;
      list-style: none;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.08),
        0 10px 26px rgba(2, 6, 23, 0.22);
      transition:
        border-color 220ms ease,
        background 220ms ease,
        box-shadow 220ms ease;
    }

    .tourney-mobile-trigger::-webkit-details-marker {
      display: none;
    }

    .tourney-menu-bars {
      position: relative;
      display: block;
      width: 18px;
      height: 18px;
    }

    .tourney-menu-bars span {
      position: absolute;
      left: 50%;
      top: 50%;
      display: block;
      width: 18px;
      height: 2px;
      border-radius: 9999px;
      background: rgba(236, 254, 255, 0.92);
      box-shadow: 0 0 10px rgba(125, 211, 252, 0.26);
      transform-origin: center;
      transition:
        transform 340ms cubic-bezier(0.16, 1, 0.3, 1),
        opacity 220ms ease,
        box-shadow 260ms ease;
      will-change: transform;
    }

    .tourney-menu-bars span:nth-child(1) {
      transform: translate(-50%, calc(-50% - 6px)) rotate(0deg);
    }

    .tourney-menu-bars span:nth-child(2) {
      transform: translate(-50%, -50%) rotate(0deg);
    }

    .tourney-menu-bars span:nth-child(3) {
      transform: translate(-50%, calc(-50% + 6px)) rotate(0deg);
    }

    .tourney-mobile-menu[open] .tourney-mobile-trigger {
      border-color: rgba(103, 232, 249, 0.46);
      background:
        radial-gradient(circle at 50% 20%, rgba(125, 211, 252, 0.22), transparent 52%),
        rgba(7, 22, 45, 0.66);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.1),
        0 0 22px rgba(56, 189, 248, 0.22);
    }

    .tourney-mobile-menu[open] .tourney-menu-bars span {
      box-shadow: 0 0 13px rgba(125, 211, 252, 0.36);
    }

    .tourney-mobile-menu[open] .tourney-menu-bars span:nth-child(1) {
      transform: translate(calc(-50% - 6px), -50%) rotate(90deg);
    }

    .tourney-mobile-menu[open] .tourney-menu-bars span:nth-child(2) {
      transform: translate(-50%, -50%) rotate(90deg);
    }

    .tourney-mobile-menu[open] .tourney-menu-bars span:nth-child(3) {
      transform: translate(calc(-50% + 6px), -50%) rotate(90deg);
    }

    .tourney-mobile-panel {
      position: fixed;
      top: var(--tourney-mobile-nav-height);
      left: 0;
      right: 0;
      display: grid;
      width: 100vw;
      gap: 0.3rem;
      overflow: hidden;
      border: 0;
      border-top: 1px solid rgba(125, 211, 252, 0.28);
      border-bottom: 1px solid rgba(125, 211, 252, 0.22);
      border-radius: 0 0 1.1rem 1.1rem;
      background:
        linear-gradient(180deg, rgba(6, 18, 38, 0.94), rgba(4, 12, 27, 0.9)),
        radial-gradient(circle at top right, rgba(103, 232, 249, 0.2), transparent 52%),
        radial-gradient(circle at bottom left, rgba(14, 165, 233, 0.17), transparent 60%);
      background-color: rgba(4, 12, 27, 0.92);
      padding:
        0.78rem max(0.875rem, env(safe-area-inset-right))
        0.92rem max(0.875rem, env(safe-area-inset-left));
      box-shadow:
        0 30px 70px rgba(2, 6, 23, 0.58),
        inset 0 1px 0 rgba(255, 255, 255, 0.16),
        inset 0 -1px 0 rgba(125, 211, 252, 0.12);
      backdrop-filter: blur(34px) saturate(190%) brightness(0.72);
      -webkit-backdrop-filter: blur(34px) saturate(190%) brightness(0.72);
      transform-origin: top center;
      animation: tourney-menu-drop 320ms cubic-bezier(0.16, 1, 0.3, 1) both;
    }

    .tourney-mobile-panel::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(120deg, rgba(255, 255, 255, 0.18), transparent 30%),
        linear-gradient(180deg, rgba(255, 255, 255, 0.12), transparent 46%),
        radial-gradient(circle at 50% 0%, rgba(125, 211, 252, 0.12), transparent 48%);
      opacity: 0.62;
    }

    .tourney-mobile-panel a {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      min-height: 2.45rem;
      border-radius: 0.65rem;
      padding: 0 0.85rem;
      color: rgba(226, 232, 240, 0.92);
      text-decoration: none;
      font-size: 0.92rem;
      font-weight: 680;
      transition:
        color 180ms ease,
        background 180ms ease,
        transform 180ms ease;
    }

    .tourney-mobile-panel a:hover,
    .tourney-mobile-panel a.is-active {
      color: #a5f3fc;
      background: rgba(255, 255, 255, 0.06);
      transform: translateX(2px);
    }

    @keyframes tourney-menu-drop {
      from {
        opacity: 0;
        transform: translateY(-10px) scaleY(0.94);
        filter: blur(2px);
      }

      to {
        opacity: 1;
        transform: translateY(0) scaleY(1);
        filter: blur(0);
      }
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

    .tourney-login-link,
    .tourney-logout {
      cursor: pointer;
      padding: 0 1rem;
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

    .tourney-hero h1,
    .tourney-route-title h1 {
      margin: 0;
      width: 100%;
      color: #fff;
      font-size: var(--hero-line1-size);
      line-height: 1.08;
      font-weight: 800;
      letter-spacing: 0;
    }

    .tourney-route-title h1 {
      font-size: clamp(2.8rem, 8vw, 5.4rem);
      line-height: 1.14;
      overflow: visible;
    }

    .tourney-title-line {
      display: block;
      width: 100%;
      text-align: center;
      overflow: visible;
    }

    .tourney-title-accent {
      background: linear-gradient(to right, #38bdf8, #3b82f6);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
      padding-bottom: 0.12em;
      margin-bottom: -0.12em;
      text-shadow: 0 0 15px rgba(56, 189, 248, 0.5);
    }

    .tourney-hero p,
    .tourney-route-title p {
      margin: 1rem auto 0;
      max-width: 42rem;
      color: rgba(226, 232, 240, 0.9);
      font-size: clamp(0.875rem, 0.75rem + 0.55vw, 1.125rem);
      line-height: 1.625;
      font-weight: 500;
    }

    .tourney-hero-actions {
      display: flex;
      justify-content: center;
      margin-top: 1.35rem;
    }

    .tourney-register-button {
      position: relative;
      isolation: isolate;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: min(100%, 12rem);
      min-height: 3.1rem;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.34);
      border-radius: 9999px;
      color: rgba(255, 255, 255, 0.96);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.04)),
        rgba(8, 18, 32, 0.52);
      padding: 0 2rem;
      font-size: 1rem;
      font-weight: 820;
      line-height: 1;
      text-decoration: none;
      text-shadow: 0 1px 2px rgba(2, 6, 23, 0.45);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.36),
        inset 0 0 0 1px rgba(255, 255, 255, 0.09),
        inset 0 -1px 0 rgba(255, 255, 255, 0.08),
        0 14px 32px rgba(2, 6, 23, 0.24);
      backdrop-filter: blur(30px) saturate(175%) brightness(1.08);
      -webkit-backdrop-filter: blur(30px) saturate(175%) brightness(1.08);
      transition:
        border-color 180ms ease,
        color 180ms ease,
        background 180ms ease,
        box-shadow 180ms ease;
    }

    .tourney-register-button::before {
      content: "";
      position: absolute;
      inset: 1px;
      z-index: 0;
      border-radius: inherit;
      background:
        linear-gradient(110deg, rgba(255, 255, 255, 0.22), transparent 30%),
        linear-gradient(290deg, rgba(255, 255, 255, 0.08), transparent 38%);
      opacity: 0.7;
      pointer-events: none;
    }

    .tourney-register-button::after {
      content: "";
      position: absolute;
      inset: 1px;
      z-index: 1;
      border-radius: inherit;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.08), transparent 44%),
        linear-gradient(90deg, transparent 10%, rgba(255, 255, 255, 0.12) 50%, transparent 90%) top / 100% 1px no-repeat;
      box-shadow:
        inset 0 -1px 0 rgba(255, 255, 255, 0.06),
        inset 0 -12px 18px rgba(2, 6, 23, 0.08);
      opacity: 0.88;
      pointer-events: none;
    }

    .tourney-register-button > span {
      position: relative;
      z-index: 2;
    }

    .tourney-register-button:hover {
      border-color: rgba(103, 232, 249, 0.72);
      color: #ecfeff;
      background:
        radial-gradient(circle at 50% 0%, rgba(125, 211, 252, 0.38), transparent 46%),
        linear-gradient(135deg, rgba(56, 189, 248, 0.34), rgba(14, 165, 233, 0.24) 48%, rgba(37, 99, 235, 0.3)),
        rgba(8, 47, 73, 0.62);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.46),
        inset 0 0 0 1px rgba(255, 255, 255, 0.12),
        inset 0 -1px 0 rgba(186, 230, 253, 0.22),
        0 0 22px rgba(56, 189, 248, 0.34),
        0 14px 32px rgba(2, 6, 23, 0.24);
      transform: none;
    }

    .tourney-register-button:hover::before {
      background:
        radial-gradient(110% 90% at 50% 0%, rgba(186, 230, 253, 0.4), transparent 48%),
        linear-gradient(110deg, rgba(255, 255, 255, 0.26), transparent 30%),
        linear-gradient(290deg, rgba(56, 189, 248, 0.14), transparent 38%);
      opacity: 0.9;
    }

    .tourney-register-button:hover::after {
      border-color: rgba(125, 211, 252, 0.34);
      background:
        linear-gradient(180deg, rgba(224, 242, 254, 0.14), transparent 44%),
        linear-gradient(90deg, transparent 10%, rgba(125, 211, 252, 0.26) 50%, transparent 90%) top / 100% 1px no-repeat;
      box-shadow:
        inset 0 -1px 0 rgba(125, 211, 252, 0.14),
        inset 0 -12px 18px rgba(8, 47, 73, 0.08);
    }

    .tourney-register-button:focus-visible {
      outline: none;
      box-shadow:
        0 0 0 3px color-mix(in srgb, var(--tourney-focus) 42%, transparent),
        0 0 22px rgba(56, 189, 248, 0.22);
    }

    .tourney-host-showcase {
      display: grid;
      gap: 18px;
      margin: 0 auto 1.125rem;
      width: 100%;
      scroll-margin-top: calc(var(--tourney-nav-offset) + 1rem);
      border: 1px solid rgba(14, 165, 233, 0.3);
      border-radius: 1rem;
      background:
        linear-gradient(145deg, rgba(11, 17, 32, 0.78), rgba(7, 24, 49, 0.62)),
        radial-gradient(circle at 50% 0%, rgba(168, 85, 247, 0.12), transparent 54%);
      padding: clamp(1.25rem, 2.4vw, 1.75rem);
      box-shadow:
        inset 0 1px 0 rgba(186, 230, 253, 0.08),
        0 0 25px rgba(14, 165, 233, 0.15);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }

    .tourney-host-showcase.is-roster {
      margin-bottom: 1.125rem;
    }

    .tourney-host-head {
      display: grid;
      gap: 4px;
      justify-items: center;
      text-align: center;
    }

    .tourney-host-head h2 {
      margin: 0;
      color: #fff;
      font-size: clamp(1.65rem, 4vw, 2.35rem);
      line-height: 1.08;
      font-weight: 820;
      letter-spacing: 0;
    }

    .tourney-host-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: clamp(14px, 2vw, 18px);
      align-items: stretch;
    }

    .tourney-host-director {
      display: grid;
      width: min(100%, 24rem);
      margin-inline: auto;
    }

    .tourney-host-showcase.is-roster .tourney-host-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      width: min(100%, 48rem);
      margin-inline: auto;
    }

    .tourney-host-card {
      display: grid;
      grid-template-rows: auto auto minmax(46px, auto);
      justify-items: center;
      align-content: start;
      gap: 12px;
      min-height: 100%;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 0.85rem;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.015)),
        rgba(15, 23, 42, 0.6);
      padding: 18px;
      text-align: center;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.07),
        0 14px 34px rgba(2, 6, 23, 0.22);
    }

    .tourney-host-card.is-featured {
      border-color: rgba(34, 211, 238, 0.34);
      background:
        radial-gradient(circle at 50% 0%, rgba(34, 211, 238, 0.13), transparent 48%),
        rgba(15, 23, 42, 0.62);
    }

    .tourney-host-card.is-live {
      border-color: rgba(248, 113, 113, 0.4);
      background:
        radial-gradient(circle at 50% 0%, rgba(239, 68, 68, 0.14), transparent 48%),
        rgba(15, 23, 42, 0.64);
    }

    .tourney-host-avatar {
      display: grid;
      place-items: center;
      width: clamp(94px, 10vw, 128px);
      height: clamp(94px, 10vw, 128px);
      overflow: hidden;
      border-radius: 9999px;
      border: 1px solid rgba(125, 211, 252, 0.34);
      background: linear-gradient(145deg, rgba(15, 23, 42, 0.86), rgba(30, 41, 59, 0.72));
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.08),
        0 0 22px rgba(56, 189, 248, 0.18);
    }

    .tourney-host-avatar img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .tourney-host-avatar.is-contained {
      border-radius: 9999px;
      background: #fff;
    }

    .tourney-host-avatar.is-contained img {
      width: 72%;
      height: 72%;
      object-fit: contain;
    }

    .tourney-host-copy {
      display: grid;
      gap: 3px;
      min-width: 0;
    }

    .tourney-host-copy strong {
      color: #fff;
      font-size: 1.16rem;
      line-height: 1.15;
      font-weight: 820;
      overflow-wrap: anywhere;
    }

    .tourney-host-name-line {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-width: 0;
      width: 100%;
    }

    .tourney-host-name-line.has-live strong {
      flex: 0 1 8.5rem;
      max-width: 8.5rem;
      min-width: 0;
      text-align: right;
    }

    .tourney-host-name-line .tourney-roster-live-badge {
      transform: translateY(0);
    }

    .tourney-host-role {
      color: rgba(203, 213, 225, 0.8);
      font-size: 0.9rem;
      line-height: 1.3;
      font-weight: 650;
    }

    .tourney-host-twitch {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      min-height: 44px;
      width: min(100%, 12.25rem);
      align-self: end;
      border: 1px solid rgba(233, 213, 255, 0.24);
      border-radius: 0.55rem;
      color: #fff;
      background: linear-gradient(135deg, #a855f7 0%, #9146ff 62%, #7e22ce 100%);
      box-shadow: 0 14px 26px rgba(88, 28, 135, 0.28);
      padding: 0 16px;
      font-size: 0.92rem;
      font-weight: 860;
      line-height: 1;
      text-decoration: none;
      white-space: nowrap;
    }

    .tourney-host-twitch svg {
      width: 20px;
      height: 20px;
      flex: 0 0 auto;
    }

    .tourney-route-title {
      max-width: 56rem;
      margin: 0 auto;
      padding: 1.25rem 0 1.35rem;
      text-align: center;
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

    .tourney-eyebrow,
    .tourney-kicker {
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

    .tourney-section-body .tourney-info-list,
    .tourney-section-body .tourney-card-list,
    .tourney-section-body .tourney-roster-list,
    .tourney-section-body .tourney-rulebook {
      padding: 0;
      list-style: none;
    }

    .tourney-info-list {
      --tourney-list-gap: clamp(16px, 2vw, 22px);
      --tourney-list-half-gap: clamp(8px, 1vw, 11px);
      counter-reset: tourney-info;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      grid-auto-rows: 1fr;
      justify-content: stretch;
      align-items: stretch;
      gap: var(--tourney-list-gap);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .tourney-card-list {
      --tourney-list-gap: clamp(16px, 2vw, 22px);
      --tourney-list-half-gap: clamp(8px, 1vw, 11px);
      counter-reset: tourney-card;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
      grid-auto-rows: 1fr;
      justify-content: stretch;
      align-items: stretch;
      gap: var(--tourney-list-gap);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .tourney-section-body .tourney-info-list,
    .tourney-section-body .tourney-card-list {
      gap: var(--tourney-list-gap);
    }

    .tourney-date-list,
    .tourney-giveaway-list,
    .tourney-bracket-list {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .tourney-info-list li,
    .tourney-card-list li {
      counter-increment: tourney-info;
      position: relative;
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      grid-auto-rows: max-content;
      column-gap: 14px;
      row-gap: 10px;
      align-items: start;
      align-content: start;
      min-width: 0;
      min-height: 100%;
      overflow: hidden;
      border: 1px solid rgba(14, 165, 233, 0.34);
      border-radius: 0.8rem;
      background:
        linear-gradient(145deg, rgba(15, 23, 42, 0.86), rgba(7, 24, 49, 0.7)),
        radial-gradient(circle at 16% 0%, rgba(125, 211, 252, 0.16), transparent 36%),
        linear-gradient(90deg, rgba(56, 189, 248, 0.08), transparent 34%);
      padding: 20px 22px 22px;
      text-align: left;
      box-shadow:
        inset 0 1px 0 rgba(186, 230, 253, 0.08),
        inset 4px 0 0 rgba(125, 211, 252, 0.16),
        0 16px 42px rgba(2, 6, 23, 0.18);
    }

    .tourney-card-list li {
      counter-increment: tourney-card;
    }

    .tourney-info-list li::before,
    .tourney-card-list li::before {
      content: counter(tourney-info);
      position: relative;
      z-index: 1;
      display: inline-grid;
      place-items: center;
      grid-column: 1;
      grid-row: 1;
      width: 34px;
      height: 34px;
      border: 1px solid rgba(125, 211, 252, 0.58);
      border-radius: 9999px;
      color: #ecfeff;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.045)),
        rgba(8, 47, 73, 0.5);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.28),
        inset 0 0 0 1px rgba(255, 255, 255, 0.08),
        0 0 0 4px rgba(14, 165, 233, 0.06),
        0 0 18px rgba(56, 189, 248, 0.14);
      backdrop-filter: blur(18px) saturate(145%);
      -webkit-backdrop-filter: blur(18px) saturate(145%);
      font-size: 0.88rem;
      font-weight: 820;
      line-height: 1;
    }

    .tourney-card-list li::before {
      content: counter(tourney-card);
    }

    .tourney-info-list li::after,
    .tourney-card-list li::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.045), transparent 34%),
        linear-gradient(90deg, rgba(125, 211, 252, 0.12), transparent 18%);
      opacity: 0.82;
    }

    .tourney-info-list strong,
    .tourney-card-list strong {
      position: relative;
      z-index: 1;
      display: block;
      grid-column: 2;
      grid-row: 1;
      margin: 0;
      color: #fff;
      font-size: 1.12rem;
      line-height: 1.18;
      font-weight: 780;
      letter-spacing: 0;
    }

    .tourney-info-list span,
    .tourney-card-list span {
      position: relative;
      z-index: 1;
      display: block;
      grid-column: 2;
      color: rgba(203, 213, 225, 0.9);
      line-height: 1.62;
      overflow-wrap: anywhere;
    }

    .tourney-info-list > li:last-child:nth-child(odd),
    .tourney-card-list > li:last-child:nth-child(odd) {
      grid-column: auto;
      justify-self: stretch;
      width: auto;
    }

    @media (min-width: 721px) {
      .tourney-info-list > li:last-child:nth-child(odd),
      .tourney-date-list > li:last-child:nth-child(odd),
      .tourney-giveaway-list > li:last-child:nth-child(odd),
      .tourney-bracket-list > li:last-child:nth-child(odd) {
        grid-column: 1 / -1;
        justify-self: center;
        width: min(100%, calc(50% - var(--tourney-list-half-gap)));
      }
    }

    .tourney-action-callout {
      display: grid;
      gap: 8px;
      margin: 0 0 18px;
      border: 1px solid rgba(251, 146, 60, 0.42);
      border-radius: 0.85rem;
      background:
        linear-gradient(145deg, rgba(154, 52, 18, 0.22), rgba(15, 23, 42, 0.7)),
        radial-gradient(circle at 0% 0%, rgba(251, 146, 60, 0.22), transparent 42%);
      padding: 18px;
      text-align: center;
      box-shadow:
        inset 0 1px 0 rgba(255, 237, 213, 0.08),
        0 0 24px rgba(251, 146, 60, 0.14);
    }

    .tourney-action-callout strong {
      color: #ffedd5;
      font-size: clamp(1.1rem, 2vw, 1.35rem);
      line-height: 1.2;
      font-weight: 860;
    }

    .tourney-action-callout span {
      color: rgba(255, 237, 213, 0.9);
      font-size: 0.98rem;
      line-height: 1.45;
      font-weight: 650;
    }

    .tourney-date-callout,
    .tourney-giveaway-callout {
      display: grid;
      gap: 9px;
      margin: 0 0 18px;
      border: 1px solid rgba(125, 211, 252, 0.38);
      border-radius: 0.95rem;
      background:
        linear-gradient(145deg, rgba(8, 47, 73, 0.32), rgba(15, 23, 42, 0.72)),
        radial-gradient(circle at 0% 0%, rgba(125, 211, 252, 0.22), transparent 42%);
      padding: 18px;
      text-align: center;
      box-shadow:
        inset 0 1px 0 rgba(186, 230, 253, 0.1),
        0 0 24px rgba(56, 189, 248, 0.12);
    }

    .tourney-date-callout strong,
    .tourney-giveaway-callout strong {
      color: #ecfeff;
      font-size: clamp(1.16rem, 2vw, 1.42rem);
      line-height: 1.2;
      font-weight: 860;
    }

    .tourney-date-callout span,
    .tourney-giveaway-callout span {
      color: rgba(226, 232, 240, 0.9);
      font-size: 0.98rem;
      line-height: 1.55;
      font-weight: 650;
    }

    .tourney-card-list .tourney-date-highlight {
      width: fit-content;
      max-width: 100%;
      margin-top: -2px;
      color: #bae6fd;
      background: linear-gradient(90deg, #e0f2fe, #38bdf8 52%, #0ea5e9);
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      font-size: 0.98rem;
      line-height: 1.18;
      font-weight: 920;
      letter-spacing: 0;
      text-shadow: 0 0 16px rgba(56, 189, 248, 0.16);
    }

    .tourney-giveaway-list {
      margin-top: 0;
    }

    .tourney-charity-callout {
      display: grid;
      gap: 9px;
      border: 1px solid rgba(52, 211, 153, 0.32);
      border-radius: 0.95rem;
      background:
        linear-gradient(145deg, rgba(6, 78, 59, 0.22), rgba(15, 23, 42, 0.72)),
        radial-gradient(circle at 0% 0%, rgba(45, 212, 191, 0.18), transparent 42%);
      padding: 18px;
      text-align: center;
      box-shadow:
        inset 0 1px 0 rgba(209, 250, 229, 0.08),
        0 0 24px rgba(20, 184, 166, 0.12);
    }

    .tourney-charity-callout strong {
      color: #d1fae5;
      font-size: clamp(1.16rem, 2vw, 1.42rem);
      line-height: 1.2;
      font-weight: 860;
    }

    .tourney-charity-callout span,
    .tourney-charity-callout small {
      color: rgba(226, 232, 240, 0.9);
      line-height: 1.55;
    }

    .tourney-charity-callout span {
      font-size: 0.98rem;
      font-weight: 650;
    }

    .tourney-charity-callout small {
      font-size: 0.82rem;
      font-weight: 620;
    }

    .tourney-charity-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
      margin-top: 16px;
    }

    .tourney-charity-card {
      position: relative;
      display: grid;
      align-content: start;
      justify-items: center;
      gap: 11px;
      min-width: 0;
      min-height: 100%;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 0.9rem;
      color: rgba(226, 232, 240, 0.9);
      background:
        linear-gradient(145deg, rgba(15, 23, 42, 0.82), rgba(7, 24, 49, 0.68));
      padding: 16px;
      text-align: center;
      text-decoration: none;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.06),
        0 16px 38px rgba(2, 6, 23, 0.18);
      transition:
        border-color 180ms ease,
        background 180ms ease,
        box-shadow 180ms ease;
    }

    .tourney-charity-card:hover {
      border-color: rgba(255, 255, 255, 0.18);
      background:
        linear-gradient(145deg, rgba(15, 23, 42, 0.84), rgba(7, 24, 49, 0.7));
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.06),
        0 16px 38px rgba(2, 6, 23, 0.2);
    }

    .tourney-charity-logo {
      display: grid;
      place-items: center;
      width: min(100%, 22rem);
      min-height: 5.25rem;
      border: 1px solid rgba(255, 255, 255, 0.62);
      border-radius: 0.7rem;
      background: rgba(255, 255, 255, 0.94);
      padding: 14px 16px;
    }

    .tourney-charity-logo picture,
    .tourney-charity-logo img {
      display: block;
      max-width: 100%;
    }

    .tourney-charity-logo img {
      width: min(100%, 19rem);
      height: auto;
      object-fit: contain;
      object-position: center;
    }

    .tourney-charity-name {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 5.25rem;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 0.7rem;
      color: rgba(255, 255, 255, 0.96);
      background: rgba(8, 17, 32, 0.56);
      padding: 12px;
      font-size: clamp(1.16rem, 2.4vw, 1.55rem);
      font-weight: 860;
      line-height: 1.12;
      text-align: center;
    }

    .tourney-charity-card strong {
      color: #fff;
      font-size: 1.05rem;
      line-height: 1.2;
      font-weight: 820;
    }

    .tourney-charity-card span:not(.tourney-charity-logo):not(.tourney-charity-name) {
      color: rgba(203, 213, 225, 0.9);
      font-size: 0.9rem;
      line-height: 1.48;
      text-align: center;
    }

    .tourney-map-process {
      display: grid;
      gap: 10px;
      margin: 18px 0;
      border: 1px solid rgba(125, 211, 252, 0.26);
      border-radius: 0.85rem;
      background: rgba(15, 23, 42, 0.48);
      padding: 16px;
    }

    .tourney-map-process strong {
      color: #fff;
      font-size: 1.05rem;
      line-height: 1.2;
    }

    .tourney-map-process p {
      margin: 0;
      color: rgba(226, 232, 240, 0.88);
      line-height: 1.55;
    }

    .tourney-rulebook-intro {
      width: min(100%, 54rem);
      margin: 0 auto 22px;
      color: rgba(226, 232, 240, 0.92);
      font-size: 1rem;
      line-height: 1.62;
      font-weight: 620;
      text-align: center;
    }

    .tourney-rulebook {
      counter-reset: tourney-rule;
      display: grid;
      grid-template-columns: 1fr;
      justify-content: stretch;
      align-items: stretch;
      gap: 14px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .tourney-rule {
      counter-increment: tourney-rule;
      position: relative;
      display: grid;
      grid-template-columns: 34px minmax(10rem, 0.32fr) minmax(0, 1fr);
      column-gap: 16px;
      row-gap: 6px;
      align-items: center;
      align-content: center;
      min-width: 0;
      min-height: auto;
      overflow: hidden;
      border: 1px solid rgba(14, 165, 233, 0.34);
      border-radius: 0.8rem;
      background:
        linear-gradient(145deg, rgba(15, 23, 42, 0.86), rgba(7, 24, 49, 0.7)),
        radial-gradient(circle at 16% 0%, rgba(125, 211, 252, 0.16), transparent 36%),
        linear-gradient(90deg, rgba(56, 189, 248, 0.08), transparent 34%);
      padding: 20px 22px 22px;
      text-align: left;
      box-shadow:
        inset 0 1px 0 rgba(186, 230, 253, 0.08),
        inset 4px 0 0 rgba(125, 211, 252, 0.16),
        0 16px 42px rgba(2, 6, 23, 0.18);
    }

    .tourney-rule::before {
      content: counter(tourney-rule);
      position: relative;
      z-index: 1;
      display: inline-grid;
      place-items: center;
      grid-column: 1;
      grid-row: 1;
      width: 34px;
      height: 34px;
      border: 1px solid rgba(125, 211, 252, 0.58);
      border-radius: 9999px;
      color: #ecfeff;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.045)),
        rgba(8, 47, 73, 0.5);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.28),
        inset 0 0 0 1px rgba(255, 255, 255, 0.08),
        0 0 0 4px rgba(14, 165, 233, 0.06),
        0 0 18px rgba(56, 189, 248, 0.14);
      backdrop-filter: blur(18px) saturate(145%);
      -webkit-backdrop-filter: blur(18px) saturate(145%);
      font-size: 0.88rem;
      font-weight: 820;
      line-height: 1;
    }

    .tourney-rule::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.045), transparent 34%),
        linear-gradient(90deg, rgba(125, 211, 252, 0.12), transparent 18%);
      opacity: 0.82;
    }

    .tourney-rule h3 {
      position: relative;
      z-index: 1;
      grid-column: 2;
      grid-row: 1;
      margin: 0;
      color: #fff;
      font-size: 1.12rem;
      line-height: 1.18;
      font-weight: 780;
      letter-spacing: 0;
    }

    .tourney-rule p {
      position: relative;
      z-index: 1;
      grid-column: 3;
      grid-row: 1;
      margin: 0;
      color: rgba(203, 213, 225, 0.9);
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    .tourney-status-panel {
      border: 1px dashed rgba(56, 189, 248, 0.45);
      border-radius: 0.75rem;
      padding: 18px;
      background: rgba(15, 23, 42, 0.52);
    }

    .tourney-status-panel h3 {
      margin: 0;
      color: #fff;
      font-size: 1.15rem;
      line-height: 1.25;
      letter-spacing: 0;
    }

    .tourney-status-panel p:last-child {
      margin: 10px 0 0;
    }

    #info {
      grid-column: 1 / -1;
      justify-self: center;
      width: 100%;
    }

    .tourney-owner-manager {
      display: grid;
      gap: 18px;
    }

    .tourney-owner-layout {
      display: grid;
      grid-template-columns: minmax(260px, 0.72fr) minmax(0, 1.28fr);
      gap: 18px;
      align-items: start;
    }

    .tourney-owner-form {
      display: grid;
      gap: 12px;
      border: 1px solid rgba(14, 165, 233, 0.3);
      border-radius: 1rem;
      background: rgba(11, 17, 32, 0.7);
      box-shadow: 0 0 25px rgba(14, 165, 233, 0.15);
      padding: 16px;
    }

    .tourney-owner-form label,
    .tourney-form label,
    .tourney-player-edit label,
    .tourney-capacity-form label,
    .tourney-owner-json {
      display: grid;
      gap: 8px;
      color: #7dd3fc;
      font-size: 0.76rem;
      font-weight: 820;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .tourney-owner-form input,
    .tourney-owner-form select,
    .tourney-owner-form textarea,
    .tourney-form input,
    .tourney-form select,
    .tourney-form textarea,
    .tourney-player-edit input,
    .tourney-player-edit select,
    .tourney-inline-form input,
    .tourney-inline-form select,
    .tourney-capacity-form input,
    .tourney-owner-actions input,
    .tourney-owner-json textarea {
      width: 100%;
      border: 1px solid rgba(14, 165, 233, 0.4);
      border-radius: 0.75rem;
      color: #fff;
      background: rgba(12, 22, 42, 0.78);
      font: inherit;
      font-size: 0.95rem;
      font-weight: 650;
      text-transform: none;
      outline: none;
    }

    .tourney-owner-form input,
    .tourney-owner-form select,
    .tourney-inline-form input,
    .tourney-inline-form select,
    .tourney-form input,
    .tourney-form select,
    .tourney-player-edit input,
    .tourney-player-edit select,
    .tourney-capacity-form input,
    .tourney-owner-actions input {
      min-height: 46px;
      padding: 0 12px;
    }

    .tourney-owner-form input::placeholder,
    .tourney-owner-form textarea::placeholder,
    .tourney-form input::placeholder,
    .tourney-form textarea::placeholder,
    .tourney-player-edit input::placeholder,
    .tourney-inline-form input::placeholder,
    .tourney-owner-actions input::placeholder {
      color: rgba(148, 163, 184, 0.78);
    }

    .tourney-owner-form input:focus,
    .tourney-owner-form select:focus,
    .tourney-owner-form textarea:focus,
    .tourney-form input:focus,
    .tourney-form select:focus,
    .tourney-form textarea:focus,
    .tourney-player-edit input:focus,
    .tourney-player-edit select:focus,
    .tourney-inline-form input:focus,
    .tourney-inline-form select:focus,
    .tourney-capacity-form input:focus,
    .tourney-owner-actions input:focus,
    .tourney-owner-json textarea:focus {
      border-color: rgba(56, 189, 248, 0.78);
      box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.18);
    }

    .tourney-owner-button,
    .tourney-owner-link {
      min-height: 42px;
      border: 1px solid rgba(125, 211, 252, 0.7);
      border-radius: 0.75rem;
      color: #fff;
      background: linear-gradient(
        120deg,
        rgba(102, 185, 250, 1) 0%,
        rgba(38, 145, 220, 1) 45%,
        rgba(18, 95, 195, 1) 100%
      );
      box-shadow:
        0 0 14px rgba(45, 212, 191, 0.28),
        0 0 26px rgba(45, 212, 191, 0.2);
      cursor: pointer;
      font: inherit;
      font-size: 0.88rem;
      font-weight: 820;
      transition: opacity 180ms ease, transform 180ms ease;
    }

    .tourney-owner-button:hover,
    .tourney-owner-link:hover {
      transform: translateY(-1px);
    }

    .tourney-owner-button:disabled,
    .tourney-owner-link:disabled {
      cursor: not-allowed;
      opacity: 0.46;
      transform: none;
    }

    .tourney-owner-table {
      display: grid;
      overflow: hidden;
      border: 1px solid rgba(14, 165, 233, 0.3);
      border-radius: 1rem;
      background: rgba(11, 17, 32, 0.8);
      box-shadow: 0 0 25px rgba(14, 165, 233, 0.15);
    }

    .tourney-owner-row {
      display: grid;
      grid-template-columns: minmax(150px, 1fr) 88px 48px minmax(260px, 1.1fr);
      gap: 10px;
      align-items: center;
      min-height: 62px;
      border-bottom: 1px solid rgba(14, 165, 233, 0.22);
      padding: 10px 12px;
      color: rgba(203, 213, 225, 0.9);
      font-size: 0.9rem;
    }

    .tourney-owner-row:last-child {
      border-bottom: 0;
    }

    .tourney-owner-row strong,
    .tourney-owner-row small {
      display: block;
      overflow-wrap: anywhere;
    }

    .tourney-owner-row strong {
      color: #fff;
      font-size: 0.96rem;
      line-height: 1.2;
    }

    .tourney-owner-row small {
      margin-top: 3px;
      color: rgba(148, 163, 184, 0.9);
      font-size: 0.76rem;
      line-height: 1.2;
      text-transform: uppercase;
    }

    .tourney-owner-row .is-active {
      color: #7dd3fc;
      font-weight: 760;
    }

    .tourney-owner-row .is-disabled {
      color: #ffd4a0;
      font-weight: 760;
    }

    .tourney-owner-link {
      min-height: 34px;
      padding-inline: 12px;
      border-radius: 0.5rem;
      font-size: 0.82rem;
    }

    .tourney-owner-link.is-danger {
      color: #fed7aa;
      border-color: rgba(251, 146, 60, 0.42);
      background: rgba(154, 52, 18, 0.42);
      box-shadow: 0 0 14px rgba(251, 146, 60, 0.18);
    }

    .tourney-owner-actions {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
    }

    .tourney-owner-actions form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }

    .tourney-owner-locked {
      color: rgba(148, 163, 184, 0.9);
      font-size: 0.8rem;
      font-weight: 740;
    }

    .tourney-owner-message {
      margin: 0;
      color: #fed7aa;
      font-size: 0.92rem;
      line-height: 1.45;
    }

    .tourney-owner-json textarea {
      min-height: 220px;
      resize: vertical;
      padding: 12px;
      color: rgba(241, 245, 249, 0.9);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.78rem;
      line-height: 1.45;
      white-space: pre;
    }

    .tourney-form {
      display: grid;
      gap: 16px;
      width: 100%;
      margin: 0;
    }

    .tourney-form-note {
      margin: 0;
      color: rgba(226, 232, 240, 0.86);
      font-size: 0.94rem;
      line-height: 1.5;
    }

    .tourney-form-narrow {
      width: min(100%, 34rem);
      margin-inline: auto;
    }

    .tourney-form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }

    .tourney-form textarea {
      min-height: 130px;
      resize: vertical;
      padding: 12px;
    }

    .tourney-owner-form textarea {
      min-height: 120px;
      resize: vertical;
      padding: 12px;
    }

    .tourney-record-panel {
      display: grid;
      gap: 18px;
    }

    .tourney-record-list {
      display: grid;
      gap: 12px;
    }

    .tourney-record-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(220px, 0.42fr);
      gap: 14px;
      align-items: start;
      border: 1px solid rgba(14, 165, 233, 0.28);
      border-radius: 0.85rem;
      background: rgba(11, 17, 32, 0.62);
      padding: 16px;
    }

    .tourney-record-row h3,
    .tourney-record-row p {
      margin: 0;
    }

    .tourney-record-row h3 {
      color: #fff;
      font-size: 1.08rem;
      line-height: 1.25;
    }

    .tourney-record-row p {
      margin-top: 8px;
      color: rgba(226, 232, 240, 0.86);
      line-height: 1.5;
    }

    .tourney-record-row small,
    .tourney-record-row a {
      display: block;
      margin-top: 8px;
      color: rgba(203, 213, 225, 0.78);
      font-size: 0.84rem;
      line-height: 1.35;
    }

    .tourney-record-row a {
      color: #7dd3fc;
      font-weight: 760;
    }

    .tourney-inline-form {
      display: grid;
      gap: 10px;
    }

    .tourney-inline-form label {
      display: grid;
      gap: 6px;
      color: #7dd3fc;
      font-size: 0.72rem;
      font-weight: 820;
      text-transform: uppercase;
    }

    .tourney-prefixed-input {
      display: grid !important;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      overflow: hidden;
      width: 100%;
      border: 1px solid rgba(14, 165, 233, 0.4);
      border-radius: 0.75rem;
      background: rgba(12, 22, 42, 0.78);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }

    .tourney-prefixed-input > span {
      display: inline-flex;
      align-items: center;
      min-height: 46px;
      padding: 0 0 0 12px;
      color: #bae6fd;
      font-size: 0.95rem;
      font-weight: 820;
      line-height: 1;
      text-transform: none;
      white-space: nowrap;
    }

    .tourney-prefixed-input input {
      border: 0 !important;
      border-radius: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
      padding-left: 3px !important;
    }

    .tourney-prefixed-input:focus-within {
      border-color: rgba(56, 189, 248, 0.78);
      box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.18);
    }

    .tourney-checkbox {
      position: relative;
      display: inline-flex !important;
      align-items: center;
      gap: 12px;
      width: fit-content;
      max-width: 100%;
      border: 1px solid rgba(56, 189, 248, 0.38);
      border-radius: 0.9rem;
      padding: 12px 15px;
      color: rgba(226, 232, 240, 0.92) !important;
      background:
        linear-gradient(180deg, rgba(15, 23, 42, 0.84), rgba(9, 18, 34, 0.7)),
        radial-gradient(circle at 20% 20%, rgba(56, 189, 248, 0.14), transparent 48%);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.06),
        0 0 18px rgba(14, 165, 233, 0.12);
      font-size: 0.94rem !important;
      line-height: 1.3;
      text-transform: none !important;
      cursor: pointer;
    }

    .tourney-checkbox input {
      display: grid;
      place-items: center;
      flex: 0 0 22px;
      width: 22px;
      height: 22px;
      min-height: 0;
      margin: 0;
      border: 1px solid rgba(125, 211, 252, 0.72);
      border-radius: 0.42rem;
      padding: 0;
      appearance: none;
      -webkit-appearance: none;
      background: rgba(8, 17, 32, 0.92);
      box-shadow:
        inset 0 0 0 1px rgba(8, 145, 178, 0.22),
        0 0 14px rgba(56, 189, 248, 0.16);
      cursor: pointer;
      transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease;
    }

    .tourney-checkbox input::before {
      content: "";
      width: 10px;
      height: 6px;
      border-left: 2px solid #06111f;
      border-bottom: 2px solid #06111f;
      opacity: 0;
      transform: translateY(-1px) rotate(-45deg) scale(0.75);
      transition: opacity 140ms ease, transform 140ms ease;
    }

    .tourney-checkbox input:checked {
      border-color: rgba(103, 232, 249, 0.95);
      background: linear-gradient(135deg, #67e8f9, #38bdf8 48%, #2563eb);
      box-shadow:
        0 0 0 3px rgba(56, 189, 248, 0.16),
        0 0 20px rgba(56, 189, 248, 0.42);
    }

    .tourney-checkbox input:checked::before {
      opacity: 1;
      transform: translateY(-1px) rotate(-45deg) scale(1);
    }

    .tourney-checkbox:has(input:focus-visible) {
      border-color: rgba(103, 232, 249, 0.88);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.06),
        0 0 0 3px rgba(56, 189, 248, 0.16),
        0 0 22px rgba(14, 165, 233, 0.18);
    }

    .tourney-form-message {
      margin: 0;
      color: #fed7aa;
      font-size: 0.94rem;
      line-height: 1.45;
    }

    .tourney-form-message.is-success {
      color: #a5f3fc;
    }

    .tourney-modal-backdrop {
      --tourney-text: #ffffff;
      --tourney-text-soft: rgba(226, 232, 240, 0.86);
      --tourney-text-muted: rgba(148, 163, 184, 0.86);
      --tourney-surface: rgba(10, 19, 36, 0.72);
      --tourney-surface-strong: rgba(6, 18, 38, 0.95);
      --tourney-surface-soft: rgba(255, 255, 255, 0.05);
      --tourney-input: #0c162a;
      --tourney-border: rgba(255, 255, 255, 0.1);
      --tourney-border-strong: rgba(148, 163, 184, 0.45);
      --tourney-border-accent: rgba(103, 232, 249, 0.3);
      --tourney-accent: #22d3ee;
      --tourney-accent-strong: #0284c7;
      --tourney-accent-glow: #03e9f4;
      --tourney-accent-soft: rgba(103, 232, 249, 0.5);
      --tourney-focus: rgba(103, 232, 249, 0.7);
      position: fixed;
      inset: 0;
      z-index: 80;
      display: grid;
      place-items: center;
      box-sizing: border-box;
      min-height: 100dvh;
      overflow-y: auto;
      padding: 18px;
      font-family: "Manrope Variable", system-ui, sans-serif;
      background: rgba(3, 7, 18, 0.74);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }

    .tourney-modal {
      display: grid;
      gap: 12px;
      width: min(100%, 31rem);
      max-height: calc(100dvh - 36px);
      overflow-y: auto;
      border: 1px solid rgba(168, 85, 247, 0.5);
      border-radius: 1rem;
      background:
        linear-gradient(145deg, rgba(15, 23, 42, 0.96), rgba(30, 15, 68, 0.9)),
        radial-gradient(circle at 18% 0%, rgba(168, 85, 247, 0.2), transparent 48%);
      box-shadow:
        0 0 0 1px rgba(233, 213, 255, 0.08),
        0 24px 70px rgba(0, 0, 0, 0.46),
        0 0 34px rgba(168, 85, 247, 0.24);
      padding: 22px;
    }

    .tourney-modal h3,
    .tourney-modal p {
      margin: 0;
    }

    .tourney-modal h3 {
      color: var(--tourney-text);
      font-size: 1.72rem;
      line-height: 1.16;
      font-weight: 780;
      letter-spacing: 0;
    }

    .tourney-modal p:not(.tourney-kicker) {
      color: var(--tourney-text-soft);
      font-size: 0.94rem;
      line-height: 1.5;
    }

    .tourney-modal-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin-top: 4px;
    }

    .tourney-modal-actions .tourney-owner-button,
    .tourney-modal-actions .tourney-owner-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 11.5rem;
      min-height: 46px;
      padding: 0.72rem 1.2rem;
      border-radius: 0.75rem;
      font-size: 0.88rem;
      font-weight: 820;
      line-height: 1.05;
      text-align: center;
      white-space: nowrap;
    }

    .tourney-section-link {
      margin: 18px 0 0;
    }

    .tourney-section-links {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .tourney-section-link a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      border: 1px solid rgba(125, 211, 252, 0.34);
      border-radius: 9999px;
      color: #dff7ff;
      background:
        linear-gradient(180deg, rgba(14, 165, 233, 0.18), rgba(15, 23, 42, 0.64));
      padding: 0 18px;
      font-weight: 820;
      line-height: 1;
      text-decoration: none;
    }

    .tourney-roster-controls {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px;
      margin: 0 0 14px;
    }

    .tourney-roster-controls button {
      min-height: 36px;
      border: 1px solid rgba(125, 211, 252, 0.35);
      border-radius: 9999px;
      color: rgba(226, 232, 240, 0.9);
      background: rgba(15, 23, 42, 0.64);
      padding: 0 14px;
      cursor: pointer;
      font: inherit;
      font-size: 0.86rem;
      font-weight: 820;
      transition: border-color 180ms ease, color 180ms ease, background 180ms ease;
    }

    .tourney-roster-controls button:hover,
    .tourney-roster-controls button.is-active {
      border-color: rgba(168, 85, 247, 0.86);
      color: #fff;
      background: rgba(88, 28, 135, 0.72);
    }

    .tourney-roster-group {
      display: grid;
      gap: 12px;
      min-width: 0;
    }

    .tourney-roster-group + .tourney-roster-group {
      margin-top: 20px;
      padding-top: 18px;
      border-top: 1px solid rgba(168, 85, 247, 0.28);
    }

    .tourney-roster-list {
      display: grid;
      gap: 12px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .tourney-roster-host-list {
      gap: 14px;
    }

    .tourney-roster-player {
      display: grid;
      grid-template-columns:
        minmax(280px, 1.15fr)
        minmax(120px, 0.45fr)
        minmax(120px, 0.45fr)
        minmax(220px, 0.62fr);
      gap: clamp(14px, 2vw, 24px);
      align-items: center;
      justify-items: stretch;
      border: 1px solid rgba(14, 165, 233, 0.26);
      border-radius: 0.8rem;
      background: rgba(11, 17, 32, 0.62);
      padding: 16px 18px;
    }

    .tourney-roster-player.is-live {
      border-color: rgba(248, 113, 113, 0.42);
      background:
        radial-gradient(circle at 7% 50%, rgba(239, 68, 68, 0.14), transparent 30%),
        rgba(11, 17, 32, 0.66);
    }

    .tourney-roster-host-row.is-featured {
      border-color: rgba(34, 211, 238, 0.34);
      background:
        radial-gradient(circle at 8% 50%, rgba(34, 211, 238, 0.12), transparent 32%),
        rgba(11, 17, 32, 0.66);
    }

    .tourney-roster-player strong,
    .tourney-roster-label {
      display: block;
    }

    .tourney-roster-player strong {
      color: #fff;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }

    .tourney-roster-label {
      margin-top: 4px;
      color: rgba(203, 213, 225, 0.78);
      font-size: 0.86rem;
      line-height: 1.3;
    }

    .tourney-roster-player > span {
      display: grid;
      justify-items: center;
      min-width: 0;
      width: 100%;
      text-align: center;
    }

    .tourney-roster-identity {
      grid-template-columns: 56px minmax(0, 1fr);
      align-items: center;
      justify-items: start;
      justify-self: stretch;
      column-gap: 14px;
      text-align: left;
    }

    .tourney-roster-detail {
      justify-items: center;
      text-align: center;
    }

    .tourney-roster-name-copy {
      min-width: 0;
      width: 100%;
    }

    .tourney-roster-player .tourney-roster-name-line {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
    }

    .tourney-roster-player .tourney-roster-name-line.has-live {
      --tourney-live-badge-slot: 5.25rem;
      display: grid;
      grid-template-columns:
        var(--tourney-live-badge-slot)
        minmax(0, 1fr)
        var(--tourney-live-badge-slot);
      align-items: center;
      justify-items: center;
      column-gap: 0;
    }

    .tourney-roster-player .tourney-roster-name-line.has-live::before {
      content: "";
      width: var(--tourney-live-badge-slot);
      height: 1px;
    }

    .tourney-roster-player
      .tourney-roster-name-line.has-live
      .tourney-roster-player-name {
      max-width: 100%;
      min-width: 0;
      text-align: center;
    }

    .tourney-roster-player
      .tourney-roster-name-line.has-live
      .tourney-roster-live-badge {
      justify-self: center;
    }

    .tourney-roster-player-name {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .tourney-roster-live-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
      vertical-align: middle;
      border: 1px solid rgba(248, 113, 113, 0.56);
      border-radius: 9999px;
      color: #fff;
      background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%);
      box-shadow: 0 0 16px rgba(239, 68, 68, 0.32);
      padding: 3px 8px;
      font-size: 0.68rem;
      font-weight: 900;
      letter-spacing: 0.02em;
      line-height: 1;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .tourney-roster-live-badge > span {
      width: 7px;
      height: 7px;
      border-radius: 9999px;
      background: #fff;
      box-shadow: 0 0 10px rgba(255, 255, 255, 0.72);
    }

    .tourney-roster-avatar {
      display: grid;
      place-items: center;
      width: 56px;
      height: 56px;
      overflow: hidden;
      border: 1px solid rgba(125, 211, 252, 0.34);
      border-radius: 9999px;
      color: #e0f2fe;
      background:
        radial-gradient(circle at 42% 22%, rgba(125, 211, 252, 0.18), transparent 44%),
        rgba(15, 23, 42, 0.84);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.08),
        0 0 18px rgba(56, 189, 248, 0.18);
      font-size: 1.18rem;
      font-weight: 900;
      line-height: 1;
    }

    .tourney-roster-avatar img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .tourney-roster-avatar.is-contained {
      background: #fff;
    }

    .tourney-roster-avatar.is-contained img {
      width: 72%;
      height: 72%;
      object-fit: contain;
    }

    .tourney-roster-cta {
      display: flex;
      justify-content: center;
      justify-self: center;
    }

    .tourney-roster-cta a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      min-height: 46px;
      width: 14rem;
      max-width: 100%;
      border: 1px solid rgba(233, 213, 255, 0.24);
      border-radius: 0.55rem;
      color: #fff;
      background: linear-gradient(135deg, #a855f7 0%, #9146ff 62%, #7e22ce 100%);
      box-shadow: 0 14px 26px rgba(88, 28, 135, 0.28);
      padding: 0 18px;
      font-weight: 860;
      line-height: 1;
      text-decoration: none;
      white-space: nowrap;
      transition: transform 180ms ease, box-shadow 180ms ease;
    }

    .tourney-roster-cta a:hover {
      transform: translateY(-1px);
      box-shadow: 0 16px 32px rgba(88, 28, 135, 0.36);
    }

    .tourney-roster-cta svg {
      width: 22px;
      height: 22px;
      flex: 0 0 auto;
    }

    .tourney-roster-cta a span {
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .tourney-roster-no-stream {
      color: rgba(203, 213, 225, 0.78);
      font-weight: 760;
    }

    .tourney-bracket-empty {
      display: grid;
      gap: 8px;
      border: 1px dashed rgba(56, 189, 248, 0.34);
      border-radius: 0.85rem;
      color: rgba(203, 213, 225, 0.86);
      background: rgba(15, 23, 42, 0.46);
      padding: 22px;
    }

    .tourney-bracket-empty strong {
      color: #fff;
      font-size: 1.1rem;
    }

    .tourney-bracket-page {
      display: grid;
      gap: 24px;
      scroll-margin-top: calc(var(--tourney-nav-offset) + 1rem);
    }

    .tourney-bracket-page-head {
      display: grid;
      gap: 8px;
      justify-items: center;
      max-width: 56rem;
      margin: 0 auto;
      min-width: 0;
      padding-top: clamp(1.1rem, 2.8vw, 2.25rem);
      text-align: center;
    }

    .tourney-bracket-page-head .tourney-eyebrow {
      letter-spacing: 0;
      text-transform: none;
    }

    .tourney-bracket-page-head h2 {
      margin: 0;
      color: #fff;
      font-size: clamp(1.85rem, 3vw, 2.7rem);
      line-height: 1.08;
      font-weight: 820;
      letter-spacing: 0;
    }

    .tourney-bracket-page-head p {
      margin: 0;
      max-width: 42rem;
      color: rgba(226, 232, 240, 0.82);
      font-size: 1rem;
      line-height: 1.5;
    }

    .tourney-bracket-board {
      --bracket-card-width: clamp(13.4rem, 16vw, 15rem);
      --bracket-band-padding: 14px;
      --bracket-band-width: calc(var(--bracket-card-width) + (var(--bracket-band-padding) * 2));
      --bracket-slot-height: 9.25rem;
      --bracket-slot-gap: 1rem;
      --bracket-lane-gap: clamp(2.25rem, 4vw, 3.5rem);
      --bracket-final-gap: clamp(5.25rem, 7vw, 7rem);
      --bracket-final-lane-width: clamp(36rem, 46vw, 46rem);
      --bracket-round-gap: clamp(2.5rem, 4vw, 3.35rem);
      --bracket-round-label-height: 1rem;
      --bracket-round-label-gap: 0.7rem;
      width: 100%;
      max-width: 100%;
      overflow-x: auto;
      overflow-y: visible;
      padding: 4px 12px 30px 0;
      scrollbar-gutter: stable;
      scrollbar-color: rgba(56, 189, 248, 0.55) rgba(15, 23, 42, 0.45);
    }

    .tourney-bracket-board::-webkit-scrollbar {
      height: 12px;
    }

    .tourney-bracket-board::-webkit-scrollbar-track {
      border-radius: 9999px;
      background: rgba(15, 23, 42, 0.56);
    }

    .tourney-bracket-board::-webkit-scrollbar-thumb {
      border: 2px solid rgba(15, 23, 42, 0.56);
      border-radius: 9999px;
      background: linear-gradient(90deg, rgba(34, 211, 238, 0.82), rgba(192, 132, 252, 0.86));
    }

    .tourney-bracket-tree,
    .tourney-bracket-lanes,
    .tourney-bracket-band,
    .tourney-bracket-rounds,
    .tourney-bracket-round,
    .tourney-bracket-stack,
    .tourney-match-card,
    .tourney-bracket-manager,
    .tourney-team-list,
    .tourney-bracket-audit {
      display: grid;
      min-width: 0;
    }

    .tourney-bracket-tree {
      position: relative;
      grid-template-columns:
        max-content
        var(--bracket-final-lane-width);
      grid-template-rows: auto auto;
      align-items: start;
      column-gap: 0;
      row-gap: var(--bracket-lane-gap);
      width: 100%;
      min-width: max-content;
      padding: 0 112px 0 0;
      isolation: isolate;
    }

    .tourney-bracket-stage-connectors {
      position: absolute;
      inset: 0;
      z-index: 5;
      width: 100%;
      height: 100%;
      overflow: visible;
      pointer-events: none;
    }

    .tourney-bracket-stage-path {
      fill: none;
      stroke: rgba(192, 132, 252, 0.76);
      stroke-width: 2.25;
      stroke-linecap: round;
      stroke-linejoin: round;
      filter: drop-shadow(0 0 10px rgba(192, 132, 252, 0.32));
      vector-effect: non-scaling-stroke;
    }

    .tourney-bracket-stage-path.is-winners {
      stroke: rgba(34, 211, 238, 0.72);
    }

    .tourney-bracket-stage-path.is-losers {
      stroke: rgba(251, 146, 60, 0.72);
    }

    .tourney-bracket-stage-arrow {
      fill: none;
      stroke: rgba(192, 132, 252, 0.9);
      stroke-width: 3;
      stroke-linecap: round;
      stroke-linejoin: round;
      filter: drop-shadow(0 0 5px rgba(192, 132, 252, 0.42));
      vector-effect: non-scaling-stroke;
    }

    .tourney-bracket-stage-arrow.is-winners {
      stroke: rgba(34, 211, 238, 0.94);
      filter: drop-shadow(0 0 5px rgba(34, 211, 238, 0.42));
    }

    .tourney-bracket-stage-arrow.is-losers {
      stroke: rgba(251, 146, 60, 0.94);
      filter: drop-shadow(0 0 5px rgba(251, 146, 60, 0.42));
    }

    .tourney-bracket-lanes {
      display: contents;
    }

    .tourney-bracket-band.is-winners {
      grid-column: 1;
      grid-row: 1;
      justify-self: start;
      width: 100%;
      z-index: 3;
    }

    .tourney-bracket-band.is-losers {
      grid-column: 1;
      grid-row: 2;
      justify-self: start;
      width: max-content;
      z-index: 3;
    }

    .tourney-finals-rail {
      position: relative;
      z-index: 7;
      display: grid;
      grid-column: 2;
      grid-row: 1 / 3;
      align-self: center;
      justify-self: center;
      min-width: var(--bracket-band-width);
    }

    .tourney-bracket-band {
      --bracket-flow: rgba(125, 211, 252, 0.74);
      position: relative;
      gap: 12px;
      min-width: max-content;
      width: 100%;
      box-sizing: border-box;
      overflow: visible;
      border-top: 3px solid rgba(125, 211, 252, 0.58);
      border-radius: 0.75rem;
      background:
        linear-gradient(180deg, rgba(14, 165, 233, 0.045), rgba(15, 23, 42, 0.012) 15rem);
      padding: var(--bracket-band-padding);
      isolation: isolate;
    }

    .tourney-bracket-band-head {
      position: relative;
      z-index: 3;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 18px;
      min-width: 0;
    }

    .tourney-bracket-band-head h3 {
      margin: 0;
      color: #e0f2fe;
      font-size: 1.12rem;
      line-height: 1.2;
      font-weight: 840;
    }

    .tourney-bracket-band-head span {
      color: rgba(203, 213, 225, 0.72);
      font-size: 0.68rem;
      font-weight: 820;
      line-height: 1.2;
      text-transform: none;
      white-space: nowrap;
    }

    .tourney-bracket-round-count {
      letter-spacing: 0;
      word-spacing: 0.18rem;
    }

    .tourney-bracket-band.is-winners {
      --bracket-flow: rgba(34, 211, 238, 0.82);
      border-top-color: rgba(34, 211, 238, 0.9);
      background:
        linear-gradient(180deg, rgba(8, 145, 178, 0.08), rgba(8, 47, 73, 0.012) 16rem);
    }

    .tourney-bracket-band.is-winners h3 {
      color: #a5f3fc;
      text-shadow: 0 0 16px rgba(34, 211, 238, 0.26);
    }

    .tourney-bracket-band.is-losers {
      --bracket-flow: rgba(251, 146, 60, 0.82);
      border-top-color: rgba(251, 146, 60, 0.88);
      background:
        linear-gradient(180deg, rgba(154, 52, 18, 0.08), rgba(69, 26, 3, 0.012) 16rem);
    }

    .tourney-bracket-band.is-losers h3 {
      color: #fed7aa;
      text-shadow: 0 0 16px rgba(251, 146, 60, 0.2);
    }

    .tourney-bracket-band.is-grand-final {
      --bracket-flow: rgba(192, 132, 252, 0.88);
      width: var(--bracket-band-width);
      min-width: var(--bracket-band-width);
      border-top-color: rgba(192, 132, 252, 0.95);
      background:
        linear-gradient(180deg, rgba(107, 33, 168, 0.1), rgba(59, 7, 100, 0.012) 16rem);
    }

    .tourney-bracket-band.is-grand-final h3 {
      color: #e9d5ff;
      text-shadow: 0 0 18px rgba(192, 132, 252, 0.26);
    }

    .tourney-bracket-rounds {
      display: grid;
      position: relative;
      z-index: 3;
      grid-template-columns: repeat(var(--round-count, 1), var(--bracket-card-width));
      align-items: start;
      gap: var(--bracket-round-gap);
      justify-content: space-between;
      width: 100%;
      min-width: max-content;
      overflow: visible;
    }

    .tourney-bracket-band.is-winners .tourney-bracket-rounds {
      justify-content: start;
      width: max-content;
    }

    .tourney-bracket-connectors {
      position: absolute;
      inset: 0;
      z-index: 2;
      width: 100%;
      height: 100%;
      overflow: visible;
      color: var(--bracket-flow);
      pointer-events: none;
    }

    .tourney-bracket-connector-path {
      fill: none;
      stroke: var(--bracket-flow);
      stroke-width: 2.25;
      stroke-linecap: round;
      stroke-linejoin: round;
      opacity: 0.88;
      filter: drop-shadow(0 0 8px color-mix(in srgb, var(--bracket-flow) 38%, transparent));
      vector-effect: non-scaling-stroke;
    }

    .tourney-bracket-connector-arrow {
      fill: none;
      stroke: var(--bracket-flow);
      stroke-width: 3;
      stroke-linecap: round;
      stroke-linejoin: round;
      filter: drop-shadow(0 0 5px color-mix(in srgb, var(--bracket-flow) 46%, transparent));
      vector-effect: non-scaling-stroke;
    }

    .tourney-bracket-round,
    .tourney-bracket-stack {
      gap: 10px;
    }

    .tourney-bracket-round {
      position: relative;
      z-index: 3;
      overflow: visible;
      grid-template-rows: var(--bracket-round-label-height) auto;
      gap: var(--bracket-round-label-gap);
    }

    .tourney-bracket-round > p {
      margin: 0;
      color: #7dd3fc;
      font-size: 0.68rem;
      font-weight: 860;
      letter-spacing: 0;
      text-transform: none;
      line-height: var(--bracket-round-label-height);
    }

    .tourney-bracket-round-label {
      display: inline-flex;
      align-items: center;
      gap: 0.28rem;
      white-space: nowrap;
    }

    .tourney-bracket-round-label b {
      font: inherit;
      color: #bae6fd;
    }

    .tourney-bracket-stack {
      position: relative;
      grid-template-rows: repeat(var(--round-size, 1), minmax(var(--bracket-slot-height), auto));
      gap: var(--bracket-slot-gap);
      min-height: var(--round-stack-height);
      overflow: visible;
    }

    .tourney-match-card {
      position: relative;
      gap: 9px;
      border: 1px solid rgba(14, 165, 233, 0.3);
      border-radius: 0.85rem;
      background:
        linear-gradient(145deg, rgba(15, 23, 42, 0.86), rgba(7, 24, 49, 0.72));
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.06),
        0 18px 42px rgba(2, 6, 23, 0.24);
      padding: 11px;
      width: 100%;
      min-width: 0;
      overflow: visible;
      align-self: center;
      grid-row: var(--slot-start, auto) / span var(--slot-span, 1);
      transform: translateY(var(--match-y-adjust, 0px));
    }

    .tourney-bracket-band.is-winners .tourney-match-card {
      border-color: rgba(34, 211, 238, 0.38);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.07),
        0 18px 42px rgba(8, 145, 178, 0.16);
    }

    .tourney-bracket-band.is-losers .tourney-match-card {
      border-color: rgba(251, 146, 60, 0.42);
      background:
        linear-gradient(145deg, rgba(30, 22, 16, 0.92), rgba(15, 23, 42, 0.72));
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.07),
        0 18px 42px rgba(154, 52, 18, 0.16);
    }

    .tourney-bracket-band.is-grand-final .tourney-match-card {
      border-color: rgba(192, 132, 252, 0.52);
      background:
        linear-gradient(145deg, rgba(34, 18, 55, 0.94), rgba(15, 23, 42, 0.72));
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.08),
        0 20px 48px rgba(126, 34, 206, 0.2);
    }

    .tourney-match-card header,
    .tourney-match-card footer,
    .tourney-match-side,
    .tourney-bracket-toolbar,
    .tourney-team-row,
    .tourney-audit-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 7px;
      min-width: 0;
    }

    .tourney-match-card header span,
    .tourney-audit-row span {
      color: rgba(203, 213, 225, 0.78);
      font-size: 0.72rem;
      font-weight: 760;
      line-height: 1.25;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tourney-match-card footer span {
      flex: 0 0 auto;
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 9999px;
      color: #cbd5e1;
      background: rgba(15, 23, 42, 0.68);
      padding: 5px 9px;
      font-size: 0.7rem;
      font-weight: 820;
      line-height: 1;
    }

    .tourney-match-card.is-ready footer span,
    .tourney-match-card.is-running footer span {
      border-color: rgba(34, 211, 238, 0.58);
      color: #cffafe;
      background: rgba(8, 145, 178, 0.28);
    }

    .tourney-match-card.is-locked footer span,
    .tourney-match-card.is-waiting footer span {
      border-color: rgba(148, 163, 184, 0.28);
      color: rgba(203, 213, 225, 0.78);
      background: rgba(15, 23, 42, 0.46);
    }

    .tourney-match-card.is-completed footer span {
      border-color: rgba(52, 211, 153, 0.52);
      color: #d1fae5;
      background: rgba(6, 95, 70, 0.28);
    }

    .tourney-match-card header strong {
      flex: 0 0 auto;
      border: 1px solid rgba(168, 85, 247, 0.4);
      border-radius: 9999px;
      color: #f5d0fe;
      background: rgba(88, 28, 135, 0.36);
      padding: 5px 9px;
      font-size: 0.7rem;
      line-height: 1;
      white-space: nowrap;
    }

    .tourney-bracket-band.is-winners .tourney-match-card header strong {
      border-color: rgba(34, 211, 238, 0.5);
      color: #cffafe;
      background: rgba(8, 145, 178, 0.28);
    }

    .tourney-bracket-band.is-losers .tourney-match-card header strong {
      border-color: rgba(251, 146, 60, 0.58);
      color: #fed7aa;
      background: rgba(154, 52, 18, 0.34);
    }

    .tourney-match-sides {
      display: grid;
      gap: 7px;
    }

    .tourney-match-side {
      border: 1px solid rgba(125, 211, 252, 0.16);
      border-radius: 0.55rem;
      background: rgba(2, 6, 23, 0.26);
      padding: 8px 9px;
    }

    .tourney-match-side.is-win {
      border-color: rgba(34, 211, 238, 0.52);
      background: rgba(8, 145, 178, 0.18);
      box-shadow: inset 4px 0 0 rgba(34, 211, 238, 0.76);
    }

    .tourney-match-side.is-loss {
      border-color: rgba(251, 146, 60, 0.34);
      background: rgba(124, 45, 18, 0.18);
      box-shadow: inset 4px 0 0 rgba(251, 146, 60, 0.68);
    }

    .tourney-match-side strong,
    .tourney-bracket-toolbar strong,
    .tourney-team-row strong,
    .tourney-audit-row strong {
      display: block;
      color: #fff;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }

    .tourney-match-side strong {
      font-size: 0.84rem;
    }

    .tourney-match-side b {
      flex: 0 0 auto;
      font-size: 0.86rem;
      line-height: 1;
    }

    .tourney-match-side small,
    .tourney-bracket-toolbar small,
    .tourney-team-row small,
    .tourney-match-card footer small,
    .tourney-audit-row small {
      display: block;
      margin-top: 3px;
      color: rgba(148, 163, 184, 0.9);
      font-size: 0.76rem;
      line-height: 1.3;
    }

    .tourney-match-side b {
      flex: 0 0 auto;
      color: #e0f2fe;
      font-size: 1.18rem;
      line-height: 1;
    }

    .tourney-bracket-manager {
      gap: 18px;
    }

    .tourney-bracket-admin-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(18rem, 0.76fr);
      gap: 18px;
      align-items: start;
    }

    .tourney-team-list,
    .tourney-bracket-audit {
      gap: 10px;
      border: 1px solid rgba(14, 165, 233, 0.2);
      border-radius: 0.85rem;
      background: rgba(7, 22, 45, 0.42);
      padding: 14px;
    }

    .tourney-team-row,
    .tourney-audit-row {
      border: 1px solid rgba(14, 165, 233, 0.22);
      border-radius: 0.72rem;
      background: rgba(15, 23, 42, 0.54);
      padding: 10px;
    }

    .tourney-team-row.is-removed {
      border-color: rgba(251, 146, 60, 0.34);
      background: rgba(49, 24, 7, 0.36);
    }

    .tourney-team-actions,
    .tourney-bracket-actions,
    .tourney-match-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }

    .tourney-bracket-toolbar {
      border: 1px solid rgba(14, 165, 233, 0.22);
      border-radius: 0.85rem;
      background: rgba(15, 23, 42, 0.52);
      padding: 14px;
    }

    .tourney-match-controls {
      display: grid;
      gap: 8px;
      border-top: 1px solid rgba(14, 165, 233, 0.18);
      padding-top: 10px;
    }

    .tourney-match-controls form {
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: 8px;
    }

    .tourney-match-controls input {
      width: 100%;
      min-height: 38px;
      border: 1px solid rgba(14, 165, 233, 0.34);
      border-radius: 0.62rem;
      color: #fff;
      background: rgba(15, 23, 42, 0.72);
      padding: 0 10px;
      font: inherit;
      font-size: 0.88rem;
      outline: none;
    }

    .tourney-player-manager {
      display: grid;
      gap: 18px;
    }

    .tourney-capacity-panel {
      display: grid;
      gap: 14px;
      border: 1px solid rgba(14, 165, 233, 0.3);
      border-radius: 1rem;
      background:
        linear-gradient(145deg, rgba(15, 23, 42, 0.8), rgba(7, 24, 49, 0.64));
      box-shadow: 0 0 25px rgba(14, 165, 233, 0.13);
      padding: 16px;
    }

    .tourney-capacity-form {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) minmax(120px, 150px) auto;
      gap: 12px;
      align-items: end;
    }

    .tourney-capacity-form > span {
      display: grid;
      gap: 4px;
      min-width: 0;
    }

    .tourney-capacity-form strong,
    .tourney-capacity-role strong {
      color: #fff;
      font-size: 0.96rem;
      line-height: 1.2;
    }

    .tourney-capacity-form small,
    .tourney-capacity-role small {
      color: rgba(203, 213, 225, 0.82);
      font-size: 0.78rem;
      line-height: 1.3;
    }

    .tourney-capacity-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }

    .tourney-capacity-role {
      display: grid;
      gap: 4px;
      border: 1px solid rgba(14, 165, 233, 0.28);
      border-radius: 0.78rem;
      background: rgba(8, 17, 32, 0.5);
      padding: 12px;
    }

    .tourney-capacity-role.is-full {
      border-color: rgba(251, 146, 60, 0.46);
      background:
        linear-gradient(145deg, rgba(49, 24, 7, 0.38), rgba(8, 17, 32, 0.58));
    }

    .tourney-player-layout {
      display: grid;
      grid-template-columns: 1fr;
      gap: 18px;
      align-items: start;
    }

    .tourney-player-layout .tourney-form-grid {
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr));
    }

    .tourney-player-table {
      display: grid;
      gap: 12px;
      min-width: 0;
    }

    .tourney-player-group {
      display: grid;
      gap: 12px;
      min-width: 0;
    }

    .tourney-player-group + .tourney-player-group {
      margin-top: 8px;
      padding-top: 16px;
      border-top: 1px solid rgba(14, 165, 233, 0.22);
    }

    .tourney-player-group-title {
      margin: 0;
      color: #7dd3fc;
      font-size: 0.75rem;
      font-weight: 860;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .tourney-player-row {
      display: grid;
      grid-template-columns:
        minmax(140px, 0.92fr)
        minmax(90px, 0.42fr)
        minmax(90px, 0.42fr)
        minmax(120px, 0.58fr)
        minmax(95px, 0.42fr)
        minmax(150px, 0.8fr)
        minmax(176px, 176px);
      gap: 12px;
      align-items: center;
      border: 1px solid rgba(14, 165, 233, 0.3);
      border-radius: 0.9rem;
      background:
        linear-gradient(145deg, rgba(15, 23, 42, 0.82), rgba(7, 24, 49, 0.68));
      padding: 14px;
      min-width: 0;
      overflow: hidden;
    }

    .tourney-player-row.is-removed {
      border-color: rgba(251, 146, 60, 0.32);
      background:
        linear-gradient(145deg, rgba(15, 23, 42, 0.78), rgba(49, 24, 7, 0.42));
    }

    .tourney-player-row strong,
    .tourney-player-row small {
      display: block;
      overflow-wrap: anywhere;
    }

    .tourney-player-row strong {
      color: #fff;
      font-size: 0.94rem;
      line-height: 1.2;
    }

    .tourney-player-row small {
      margin-top: 4px;
      color: rgba(148, 163, 184, 0.92);
      font-size: 0.78rem;
      line-height: 1.3;
    }

    .tourney-player-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      width: 100%;
    }

    .tourney-player-edit {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(4, minmax(140px, 1fr)) auto;
      gap: 12px;
      align-items: end;
      border-top: 1px solid rgba(14, 165, 233, 0.22);
      padding-top: 12px;
    }

    .tourney-player-edit-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }

    .tourney-player-notes {
      grid-column: 1 / -1;
      margin: 0;
      color: rgba(203, 213, 225, 0.86);
      font-size: 0.88rem;
      line-height: 1.45;
    }

    .tourney-empty {
      margin: 0;
      border: 1px dashed rgba(56, 189, 248, 0.34);
      border-radius: 0.75rem;
      padding: 18px;
      color: rgba(203, 213, 225, 0.86);
      background: rgba(15, 23, 42, 0.46);
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

    .tourney-nav,
    .tourney-mobile-panel {
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
    .tourney-route-title h1,
    .tourney-host-head h2,
    .tourney-section h2,
    .tourney-status-panel h3,
    .tourney-owner-row strong,
    .tourney-record-row h3,
    .tourney-bracket-page-head h2,
    .tourney-charity-card strong,
    .tourney-match-side strong,
    .tourney-bracket-toolbar strong,
    .tourney-team-row strong,
    .tourney-audit-row strong,
    .tourney-player-row strong,
    .tourney-capacity-form strong,
    .tourney-capacity-role strong,
    .tourney-empty strong,
    .tourney-bracket-empty strong {
      color: var(--tourney-text);
    }

    .tourney-brand-copy span,
    .tourney-hero p,
    .tourney-route-title p,
    .tourney-section-body,
    .tourney-info-list span,
    .tourney-card-list span,
    .tourney-charity-card span:not(.tourney-charity-logo):not(.tourney-charity-name),
    .tourney-charity-callout span,
    .tourney-charity-callout small,
    .tourney-rule p,
    .tourney-form-note,
    .tourney-record-row p,
    .tourney-bracket-page-head p,
    .tourney-player-notes,
    .tourney-empty,
    .tourney-bracket-empty {
      color: var(--tourney-text-soft);
    }

    .tourney-owner-row small,
    .tourney-record-row small,
    .tourney-record-row a,
    .tourney-roster-label,
    .tourney-bracket-band-head span,
    .tourney-match-card header span,
    .tourney-match-card footer span,
    .tourney-audit-row span,
    .tourney-match-side small,
    .tourney-bracket-toolbar small,
    .tourney-team-row small,
    .tourney-match-card footer small,
    .tourney-audit-row small,
    .tourney-capacity-form small,
    .tourney-capacity-role small,
    .tourney-player-row small,
    .tourney-roster-no-stream {
      color: var(--tourney-text-muted);
    }

    .tourney-title-accent {
      background: var(--gradient-glint-text);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      text-shadow: var(--text-shadow-glint);
    }

    .tourney-eyebrow,
    .tourney-kicker,
    .tourney-owner-form label,
    .tourney-form label,
    .tourney-player-edit label,
    .tourney-capacity-form label,
    .tourney-owner-json,
    .tourney-inline-form label,
    .tourney-player-group-title,
    .tourney-bracket-round > p,
    .tourney-bracket-round-label b,
    .tourney-record-row a,
    .tourney-owner-row .is-active {
      color: var(--tourney-accent);
    }

    .tourney-links a,
    .tourney-login-link,
    .tourney-logout,
    .tourney-theme-switch .theme-switch-track,
    .tourney-mobile-trigger,
    .tourney-roster-controls button,
    .tourney-section-link a,
    .tourney-register-button,
    .tourney-badge {
      border-color: var(--tourney-border);
      color: var(--tourney-text-soft);
      background: var(--tourney-surface-soft);
      box-shadow: none;
    }

    .tourney-links a:hover,
    .tourney-links a.is-active,
    .tourney-login-link:hover,
    .tourney-logout:hover,
    .tourney-theme-switch:hover .theme-switch-track,
    .tourney-mobile-panel a:hover,
    .tourney-mobile-panel a.is-active,
    .tourney-roster-controls button:hover,
    .tourney-roster-controls button.is-active,
    .tourney-section-link a:hover,
    .tourney-register-button:hover {
      border-color: var(--tourney-border-accent);
      color: var(--tourney-accent);
      background: var(--color-surface-hover-accent);
    }

    .tourney-register-button {
      border-color: rgba(255, 255, 255, 0.34);
      color: rgba(255, 255, 255, 0.96);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.04)),
        color-mix(in srgb, var(--tourney-surface-strong) 62%, transparent);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.36),
        inset 0 0 0 1px rgba(255, 255, 255, 0.09),
        inset 0 -1px 0 rgba(255, 255, 255, 0.08),
        0 14px 32px rgba(0, 0, 0, 0.24);
    }

    .tourney-register-button:hover {
      border-color: rgba(103, 232, 249, 0.72);
      color: #ecfeff;
      background:
        radial-gradient(circle at 50% 0%, rgba(125, 211, 252, 0.38), transparent 46%),
        linear-gradient(135deg, rgba(56, 189, 248, 0.34), rgba(14, 165, 233, 0.24) 48%, rgba(37, 99, 235, 0.3)),
        rgba(8, 47, 73, 0.62);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.46),
        inset 0 0 0 1px rgba(255, 255, 255, 0.12),
        inset 0 -1px 0 rgba(186, 230, 253, 0.22),
        0 0 22px rgba(56, 189, 248, 0.34),
        0 14px 32px rgba(0, 0, 0, 0.24);
      transform: none;
    }

    .tourney-mobile-menu[open] .tourney-mobile-trigger {
      border-color: var(--tourney-border-accent);
      background: var(--gradient-glass-lite);
      box-shadow: var(--shadow-glow-soft);
    }

    .tourney-menu-bars span {
      background: var(--tourney-text);
      box-shadow: 0 0 10px color-mix(in srgb, var(--tourney-accent-glow) 24%, transparent);
    }

    .tourney-mobile-panel::before {
      background:
        linear-gradient(120deg, rgba(255, 255, 255, 0.1), transparent 30%),
        radial-gradient(circle at 50% 0%, var(--color-surface-hover-accent), transparent 48%);
    }

    .tourney-host-showcase,
    .tourney-section,
    .tourney-owner-form,
    .tourney-owner-table,
    .tourney-record-row,
    .tourney-bracket-toolbar,
    .tourney-team-list,
    .tourney-bracket-audit,
    .tourney-capacity-panel,
    .tourney-player-row,
    .tourney-host-card,
    .tourney-roster-player,
    .tourney-match-card,
    .tourney-team-row,
    .tourney-audit-row,
    .tourney-capacity-role,
    .tourney-bracket-empty,
    .tourney-empty,
    .tourney-status-panel,
    .tourney-map-process {
      border-color: var(--tourney-border-accent);
      background:
        linear-gradient(145deg, var(--tourney-surface), var(--tourney-surface-strong));
      box-shadow: var(--tourney-card-shadow);
    }

    .tourney-info-list li,
    .tourney-card-list li,
    .tourney-rule {
      border-color: var(--tourney-border-accent);
      background:
        linear-gradient(145deg, var(--tourney-surface), var(--tourney-surface-strong)),
        radial-gradient(circle at 16% 0%, var(--color-surface-hover-accent), transparent 36%);
      box-shadow:
        var(--highlight-glass-top),
        inset 4px 0 0 var(--tourney-accent-soft),
        var(--shadow-surface);
    }

    .tourney-info-list li::before,
    .tourney-card-list li::before,
    .tourney-rule::before {
      border-color: color-mix(in srgb, var(--tourney-accent) 46%, rgba(255, 255, 255, 0.28));
      color: var(--tourney-text);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.045)),
        color-mix(in srgb, var(--tourney-surface-strong) 54%, transparent);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.24),
        inset 0 0 0 1px rgba(255, 255, 255, 0.08),
        0 0 0 4px color-mix(in srgb, var(--tourney-accent) 8%, transparent),
        0 0 18px color-mix(in srgb, var(--tourney-accent-glow) 14%, transparent);
    }

    .tourney-info-list li::after,
    .tourney-card-list li::after,
    .tourney-rule::after {
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.045), transparent 34%),
        linear-gradient(90deg, var(--color-surface-hover-accent), transparent 18%);
    }

    .tourney-host-card.is-featured,
    .tourney-roster-host-row.is-featured {
      border-color: var(--tourney-border-accent);
      background:
        radial-gradient(circle at 50% 0%, var(--color-surface-hover-accent), transparent 48%),
        var(--tourney-surface);
    }

    .tourney-host-avatar,
    .tourney-roster-avatar {
      border-color: var(--tourney-border-accent);
      color: var(--tourney-accent);
      background:
        radial-gradient(circle at 42% 22%, var(--color-surface-hover-accent), transparent 44%),
        var(--tourney-surface-strong);
      box-shadow: var(--highlight-glass-top), var(--shadow-glow-soft);
    }

    .tourney-host-avatar.is-contained,
    .tourney-roster-avatar.is-contained {
      background: #fff;
    }

    .tourney-owner-form input,
    .tourney-owner-form select,
    .tourney-owner-form textarea,
    .tourney-form input,
    .tourney-form select,
    .tourney-form textarea,
    .tourney-player-edit input,
    .tourney-player-edit select,
    .tourney-inline-form input,
    .tourney-inline-form select,
    .tourney-capacity-form input,
    .tourney-owner-actions input,
    .tourney-owner-json textarea,
    .tourney-match-controls input,
    .tourney-prefixed-input {
      border-color: var(--color-border-input);
      color: var(--tourney-text);
      background: var(--tourney-input);
    }

    .tourney-owner-form input::placeholder,
    .tourney-owner-form textarea::placeholder,
    .tourney-form input::placeholder,
    .tourney-form textarea::placeholder,
    .tourney-player-edit input::placeholder,
    .tourney-inline-form input::placeholder,
    .tourney-owner-actions input::placeholder {
      color: var(--tourney-text-muted);
    }

    .tourney-owner-form input:focus,
    .tourney-owner-form select:focus,
    .tourney-owner-form textarea:focus,
    .tourney-form input:focus,
    .tourney-form select:focus,
    .tourney-form textarea:focus,
    .tourney-player-edit input:focus,
    .tourney-player-edit select:focus,
    .tourney-inline-form input:focus,
    .tourney-inline-form select:focus,
    .tourney-capacity-form input:focus,
    .tourney-owner-actions input:focus,
    .tourney-owner-json textarea:focus,
    .tourney-match-controls input:focus,
    .tourney-prefixed-input:focus-within {
      border-color: var(--tourney-focus);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--tourney-focus) 26%, transparent);
    }

    .tourney-owner-button,
    .tourney-owner-link {
      border-color: var(--tourney-border-accent);
      color: var(--tourney-text);
      background: var(--gradient-button-primary);
      box-shadow: var(--shadow-button);
    }

    .tourney-checkbox {
      border-color: var(--tourney-border-accent);
      color: var(--tourney-text-soft) !important;
      background:
        linear-gradient(180deg, var(--tourney-surface), var(--tourney-surface-strong)),
        radial-gradient(circle at 20% 20%, var(--color-surface-hover-accent), transparent 48%);
      box-shadow: var(--highlight-glass-top), var(--shadow-surface);
    }

    .tourney-checkbox input {
      border-color: var(--tourney-border-accent);
      background: var(--tourney-input);
      box-shadow: inset 0 0 0 1px var(--color-surface-hover-accent);
    }

    .tourney-checkbox input:checked {
      border-color: var(--tourney-focus);
      background: var(--gradient-button-primary);
      box-shadow: var(--shadow-button-accent);
    }

    .tourney-checkbox input:checked::before {
      border-color: var(--tourney-accent-contrast);
    }

    .tourney-modal {
      border-color: var(--tourney-border-accent);
      background: var(--gradient-glass-lite);
      box-shadow:
        0 0 0 1px var(--tourney-border),
        0 24px 70px rgba(0, 0, 0, 0.46),
        var(--shadow-glow-soft);
    }

    .tourney-form-message,
    .tourney-owner-message,
    .tourney-owner-row .is-disabled {
      color: var(--color-warning-text);
    }

    .tourney-form-message.is-success,
    .tourney-match-card.is-completed footer span {
      color: var(--color-success-text);
    }

    .tourney-bracket-board {
      scrollbar-color: var(--tourney-accent) var(--tourney-surface-strong);
    }

    .tourney-bracket-board::-webkit-scrollbar-track {
      background: var(--tourney-surface-strong);
    }

    .tourney-bracket-board::-webkit-scrollbar-thumb {
      border-color: var(--tourney-surface-strong);
      background: linear-gradient(90deg, var(--tourney-accent), var(--tourney-accent-glow));
    }

    .tourney-bracket-band,
    .tourney-bracket-band.is-winners,
    .tourney-bracket-band.is-grand-final {
      --bracket-flow: var(--tourney-accent-soft);
      border-top-color: var(--tourney-border-accent);
      background:
        linear-gradient(180deg, var(--color-surface-hover-accent), transparent 16rem);
    }

    .tourney-bracket-band.is-winners h3,
    .tourney-bracket-band.is-grand-final h3,
    .tourney-bracket-band-head h3,
    .tourney-match-side b {
      color: var(--tourney-accent);
      text-shadow: var(--text-shadow-heading-soft);
    }

    .tourney-bracket-stage-path,
    .tourney-bracket-stage-arrow,
    .tourney-bracket-stage-path.is-winners,
    .tourney-bracket-stage-arrow.is-winners {
      stroke: var(--tourney-accent-soft);
      filter: drop-shadow(0 0 8px color-mix(in srgb, var(--tourney-accent-glow) 32%, transparent));
    }

    .tourney-bracket-band.is-winners .tourney-match-card,
    .tourney-bracket-band.is-grand-final .tourney-match-card {
      border-color: var(--tourney-border-accent);
      background:
        linear-gradient(145deg, var(--tourney-surface), var(--tourney-surface-strong));
      box-shadow: var(--tourney-card-shadow);
    }

    .tourney-match-card.is-ready footer span,
    .tourney-match-card.is-running footer span,
    .tourney-bracket-band.is-winners .tourney-match-card header strong {
      border-color: var(--tourney-border-accent);
      color: var(--tourney-accent);
      background: var(--color-surface-hover-accent);
    }

    .tourney-match-side,
    .tourney-match-side.is-win {
      border-color: var(--tourney-border);
      background: var(--tourney-surface-soft);
      box-shadow: inset 4px 0 0 var(--tourney-accent-soft);
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

    html[data-theme="dark"] .tourney-page,
    html[data-theme="dark"] .tourney-modal-backdrop {
      --tourney-text: var(--color-text-primary);
      --tourney-text-soft: var(--color-text-secondary);
      --tourney-text-muted: #9f9a8a;
      --tourney-surface: var(--color-surface-card);
      --tourney-surface-strong: var(--color-surface-solid);
      --tourney-surface-soft: var(--color-surface-hover);
      --tourney-input: var(--color-surface-input);
      --tourney-border: var(--color-border-soft);
      --tourney-border-strong: var(--color-border-strong);
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

    html[data-theme="dark"] .tourney-title-accent,
    html[data-theme="dark"] .tourney-badge,
    html[data-theme="dark"] .tourney-eyebrow,
    html[data-theme="dark"] .tourney-kicker {
      text-shadow: 0 0 10px rgba(255, 215, 110, 0.18);
    }

    html[data-theme="dark"] .tourney-register-button:hover {
      border-color: rgba(253, 224, 71, 0.72);
      color: #fff7d6;
      background:
        radial-gradient(circle at 50% 0%, rgba(254, 240, 138, 0.38), transparent 46%),
        linear-gradient(135deg, rgba(251, 191, 36, 0.34), rgba(245, 158, 11, 0.24) 48%, rgba(253, 224, 71, 0.32)),
        rgba(46, 29, 8, 0.62);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.46),
        inset 0 0 0 1px rgba(255, 255, 255, 0.12),
        inset 0 -1px 0 rgba(254, 243, 199, 0.22),
        0 0 22px rgba(251, 191, 36, 0.34),
        0 14px 32px rgba(0, 0, 0, 0.24);
      transform: none;
    }

    html[data-theme="dark"] .tourney-register-button:hover::before {
      background:
        radial-gradient(110% 90% at 50% 0%, rgba(255, 247, 190, 0.4), transparent 48%),
        linear-gradient(110deg, rgba(255, 255, 255, 0.26), transparent 30%),
        linear-gradient(290deg, rgba(253, 224, 71, 0.14), transparent 38%);
      opacity: 0.9;
    }

    html[data-theme="dark"] .tourney-register-button:hover::after {
      border-color: rgba(253, 230, 138, 0.34);
      background:
        linear-gradient(180deg, rgba(255, 248, 209, 0.14), transparent 44%),
        linear-gradient(90deg, transparent 10%, rgba(254, 240, 138, 0.26) 50%, transparent 90%) top / 100% 1px no-repeat;
      box-shadow:
        inset 0 -1px 0 rgba(253, 230, 138, 0.14),
        inset 0 -12px 18px rgba(69, 26, 3, 0.08);
    }

    html[data-theme="dark"] .tourney-charity-callout {
      border-color: rgba(255, 215, 110, 0.24);
      background:
        linear-gradient(145deg, rgba(13, 13, 13, 0.88), rgba(24, 20, 12, 0.7)),
        radial-gradient(circle at 0% 0%, rgba(255, 215, 110, 0.12), transparent 42%);
      box-shadow:
        inset 0 1px 0 rgba(255, 244, 214, 0.08),
        0 0 24px rgba(255, 215, 110, 0.08);
    }

    html[data-theme="dark"] .tourney-charity-callout strong {
      color: #fff4d6;
    }

    html[data-theme="dark"] .tourney-charity-callout span,
    html[data-theme="dark"] .tourney-charity-callout small {
      color: color-mix(in srgb, var(--tourney-text-soft) 92%, #fff4d6);
    }

    html[data-theme="dark"] .tourney-date-callout,
    html[data-theme="dark"] .tourney-giveaway-callout {
      border-color: rgba(255, 215, 110, 0.26);
      background:
        linear-gradient(145deg, rgba(13, 13, 13, 0.88), rgba(24, 20, 12, 0.7)),
        radial-gradient(circle at 0% 0%, rgba(255, 215, 110, 0.13), transparent 42%);
      box-shadow:
        inset 0 1px 0 rgba(255, 244, 214, 0.08),
        0 0 24px rgba(255, 215, 110, 0.08);
    }

    html[data-theme="dark"] .tourney-date-callout strong,
    html[data-theme="dark"] .tourney-giveaway-callout strong {
      color: #fff4d6;
    }

    html[data-theme="dark"] .tourney-date-callout span,
    html[data-theme="dark"] .tourney-giveaway-callout span {
      color: color-mix(in srgb, var(--tourney-text-soft) 92%, #fff4d6);
    }

    html[data-theme="dark"] .tourney-card-list .tourney-date-highlight {
      background: linear-gradient(90deg, #fff7d6, #ffd76e 52%, #c78b16);
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      text-shadow: 0 0 16px rgba(255, 215, 110, 0.14);
    }

    html[data-theme="dark"] .tourney-charity-card {
      border-color: rgba(255, 215, 110, 0.2);
      background:
        linear-gradient(145deg, rgba(13, 13, 13, 0.84), rgba(22, 18, 9, 0.58));
      box-shadow:
        inset 0 1px 0 rgba(255, 244, 214, 0.08),
        0 16px 38px rgba(0, 0, 0, 0.26);
    }

    html[data-theme="dark"] .tourney-charity-card:hover {
      border-color: rgba(255, 215, 110, 0.24);
      background:
        linear-gradient(145deg, rgba(15, 15, 15, 0.86), rgba(24, 20, 12, 0.6));
      box-shadow:
        inset 0 1px 0 rgba(255, 244, 214, 0.08),
        0 16px 38px rgba(0, 0, 0, 0.28);
    }

    html[data-theme="dark"] .tourney-charity-name {
      border-color: rgba(255, 215, 110, 0.16);
      color: var(--tourney-text);
      background: rgba(8, 8, 8, 0.56);
    }

    html[data-theme="dark"] .tourney-charity-logo {
      border-color: rgba(255, 244, 214, 0.58);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.34);
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

      .tourney-host-grid,
      .tourney-host-showcase.is-roster .tourney-host-grid {
        grid-template-columns: 1fr;
        width: 100%;
      }

      .tourney-host-director {
        width: 100%;
      }

      .tourney-info-list,
      .tourney-card-list,
      .tourney-charity-grid {
        grid-template-columns: 1fr;
        justify-content: stretch;
      }

      .tourney-rulebook {
        grid-template-columns: 1fr;
        justify-content: stretch;
      }

      .tourney-section-wide {
        grid-column: auto;
      }

      .tourney-owner-layout {
        grid-template-columns: 1fr;
      }

      .tourney-bracket-admin-grid,
      .tourney-bracket-board {
        grid-template-columns: 1fr;
      }

      .tourney-bracket-toolbar {
        align-items: flex-start;
        flex-direction: column;
      }

      .tourney-player-layout {
        grid-template-columns: 1fr;
      }

      .tourney-capacity-form {
        grid-template-columns: minmax(0, 1fr) minmax(120px, 150px) auto;
      }

      .tourney-capacity-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .tourney-roster-player,
      .tourney-player-row {
        grid-template-columns: 1fr 1fr;
      }

      .tourney-section-body .tourney-roster-list,
      .tourney-roster-group,
      .tourney-roster-player {
        width: 100%;
        min-width: 0;
        justify-self: stretch;
      }

      .tourney-roster-player > .tourney-roster-identity {
        grid-column: 1 / -1;
        justify-content: center;
        justify-items: center;
        justify-self: center;
        width: 100%;
        text-align: center;
      }

      .tourney-roster-cta {
        grid-column: 1 / -1;
      }

      .tourney-roster-cta {
        justify-self: center;
        width: min(100%, 18rem);
      }

      .tourney-roster-cta a {
        width: 100%;
      }

      .tourney-player-actions,
      .tourney-player-edit,
      .tourney-player-notes {
        grid-column: 1 / -1;
      }

      .tourney-player-edit {
        grid-template-columns: 1fr 1fr;
      }

      .tourney-record-row {
        grid-template-columns: 1fr;
      }

      .tourney-player-edit-actions {
        grid-column: 1 / -1;
      }
    }

    @media (max-width: 640px) {
      .tourney-page {
        --tourney-nav-offset: 5rem;
        --tourney-mobile-nav-height: 4.5rem;
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

      .tourney-mobile-menu {
        position: static;
        display: block;
        flex: 0 0 auto;
        order: 5;
        margin-left: 0;
      }

      .tourney-theme-switch {
        order: 3;
        margin-left: auto;
      }

      .tourney-session {
        gap: 7px;
        order: 4;
        margin-left: 0;
      }

      .tourney-login-link,
      .tourney-logout {
        min-height: 34px;
        padding-inline: 10px;
        font-size: 0.78rem;
      }

      .tourney-hero {
        min-height: 16rem;
        padding: 1.5rem 0 2rem;
      }

      .tourney-hero h1 {
        font-size: 2.28rem;
      }

      .tourney-hero-actions {
        margin-top: 1.1rem;
      }

      .tourney-register-button {
        width: min(100%, 15rem);
        min-height: 2.85rem;
      }

      .tourney-route-title {
        padding-top: 0.85rem;
        padding-bottom: 1.1rem;
      }

      .tourney-route-title h1 {
        font-size: 2.6rem;
      }

      .tourney-section {
        padding: 22px;
      }

      .tourney-host-card {
        padding: 16px;
      }

      .tourney-host-twitch {
        width: 100%;
      }

      .tourney-info-list li,
      .tourney-card-list li {
        grid-template-columns: 30px minmax(0, 1fr);
        column-gap: 12px;
        padding: 16px;
      }

      .tourney-info-list li::before,
      .tourney-card-list li::before {
        width: 30px;
        height: 30px;
        font-size: 0.82rem;
      }

      .tourney-rule {
        grid-template-columns: 30px minmax(0, 1fr);
        column-gap: 12px;
        padding: 16px;
      }

      .tourney-rule p {
        grid-column: 2;
        grid-row: auto;
      }

      .tourney-rule::before {
        width: 30px;
        height: 30px;
        font-size: 0.82rem;
      }

      .tourney-owner-row {
        grid-template-columns: 1fr 86px;
      }

      .tourney-owner-row > span:nth-child(3) {
        display: none;
      }

      .tourney-owner-actions {
        grid-column: 1 / -1;
        grid-template-columns: 1fr;
      }

      .tourney-owner-actions form {
        grid-template-columns: 1fr;
      }

      .tourney-form-grid,
      .tourney-capacity-form,
      .tourney-roster-player,
      .tourney-player-row,
      .tourney-player-edit {
        grid-template-columns: 1fr;
      }

      .tourney-roster-player {
        align-items: center;
        gap: 14px;
        justify-items: center;
        padding: 16px;
        text-align: center;
      }

      .tourney-roster-player > .tourney-roster-identity {
        grid-template-columns: minmax(0, 1fr);
        row-gap: 10px;
        justify-content: center;
        justify-items: center;
        text-align: center;
      }

      .tourney-roster-player
        .tourney-roster-name-line.has-live
        .tourney-roster-player-name {
        max-width: min(14rem, 48vw);
      }

      .tourney-roster-player > .tourney-roster-detail {
        justify-items: center;
        text-align: center;
      }

      .tourney-roster-cta {
        justify-self: center;
        width: min(100%, 18rem);
      }

      .tourney-roster-cta a {
        width: 100%;
      }

      .tourney-capacity-grid {
        grid-template-columns: 1fr;
      }

      .tourney-modal-actions {
        display: grid;
      }

      .tourney-modal-actions .tourney-owner-button,
      .tourney-modal-actions .tourney-owner-link {
        width: 100%;
        min-width: 0;
      }

      .tourney-match-controls form {
        grid-template-columns: 1fr 1fr;
      }

      .tourney-match-controls form .tourney-owner-link {
        grid-column: 1 / -1;
      }

      .tourney-team-row,
      .tourney-audit-row {
        align-items: flex-start;
        flex-direction: column;
      }

      .tourney-player-edit-actions {
        justify-content: stretch;
      }

      .tourney-player-edit-actions .tourney-owner-link {
        flex: 1 1 120px;
      }
    }

    html.low-performance-mode .tourney-page {
      background-attachment: scroll;
    }

    html.low-performance-mode .tourney-nav,
    html.low-performance-mode .tourney-mobile-panel {
      -webkit-backdrop-filter: none !important;
      backdrop-filter: none !important;
      background-image: none !important;
      background-color: var(--tourney-surface-strong) !important;
      box-shadow: var(--highlight-glass-top) !important;
      isolation: auto !important;
    }

    html.low-performance-mode .tourney-mobile-panel::before,
    html.low-performance-mode .app-bg-grid-layer,
    html.low-performance-mode .app-bg-radial-layer {
      display: none !important;
    }

    html.low-performance-mode .tourney-brand-logo img,
    html.low-performance-mode .tourney-menu-bars span,
    html.low-performance-mode .tourney-title-accent,
    html.low-performance-mode .tourney-host-avatar,
    html.low-performance-mode .tourney-roster-avatar {
      filter: none !important;
      text-shadow: none !important;
      box-shadow: none !important;
    }

    html.low-performance-mode .tourney-mobile-panel,
    html.low-performance-mode .tourney-mobile-panel a,
    html.low-performance-mode .tourney-mobile-trigger,
    html.low-performance-mode .tourney-menu-bars span,
    html.low-performance-mode .tourney-roster-cta a {
      animation: none !important;
      transition-property: opacity, transform !important;
    }
  `}</style>
);

const LockStyles = () => (
  <style>{`
    .cs-page {
      --metal-1: var(--color-surface-hover);
      --metal-2: var(--color-surface);
      --metal-3: var(--color-surface-elevated);
      --metal-4: var(--color-surface-solid);
      --metal-5: var(--color-canvas);
      --metal-6: var(--color-canvas-deep);
      --text: var(--color-text-primary);
      --muted: var(--color-text-secondary);
      --accent: var(--color-accent);
      min-height: 100vh;
      color: var(--text);
      font-family: "Manrope Variable", system-ui, sans-serif;
      background: var(--gradient-app-bg);
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

    .cs-login {
      display: grid;
      gap: 12px;
      width: min(100%, 360px);
      margin: 28px auto 0;
    }

    .cs-field {
      width: 100%;
      min-height: 54px;
      border: 1px solid var(--color-border-input);
      border-radius: 999px;
      padding: 0 22px;
      color: var(--text);
      background: var(--color-surface-input);
      font: inherit;
      font-size: 1rem;
      font-weight: 650;
      text-align: center;
      outline: none;
      box-shadow:
        0 18px 44px rgba(0, 0, 0, 0.14),
        inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }

    .cs-field::placeholder {
      color: var(--color-text-muted);
    }

    .cs-field:focus {
      border-color: var(--color-focus-ring);
      box-shadow:
        0 18px 44px rgba(0, 0, 0, 0.2),
        0 0 0 3px color-mix(in srgb, var(--color-focus-ring) 28%, transparent);
    }

    .cs-remember {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      min-height: 40px;
      color: rgba(225, 234, 242, 0.78);
      font-size: 0.92rem;
      font-weight: 650;
      cursor: pointer;
      user-select: none;
    }

    .cs-remember input {
      width: 18px;
      height: 18px;
      margin: 0;
      accent-color: var(--accent);
      cursor: pointer;
    }

    .cs-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 58px;
      min-width: min(100%, 220px);
      border: 1px solid var(--color-border-accent);
      border-radius: 999px;
      padding: 0 30px;
      background: var(--gradient-button-primary);
      color: var(--text);
      cursor: pointer;
      font: inherit;
      font-size: 1rem;
      font-weight: 770;
      letter-spacing: -0.01em;
      box-shadow:
        var(--shadow-button),
        inset 0 1px 0 rgba(255, 255, 255, 0.18);
      transition:
        transform 180ms ease,
        box-shadow 180ms ease,
        filter 180ms ease;
    }

    .cs-button:hover {
      transform: translateY(-1px);
      filter: saturate(1.04);
      box-shadow:
        0 22px 52px rgba(0, 0, 0, 0.42),
        inset 0 1px 0 rgba(255, 255, 255, 0.5);
    }

    .cs-social {
      display: grid;
      gap: 12px;
      width: min(100%, 360px);
      margin: 18px auto 0;
    }

    .cs-social-divider {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .cs-social-divider-line {
      flex: 1;
      height: 1px;
      background: var(--color-border-input);
    }

    .cs-social-divider-label {
      color: var(--color-text-muted);
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    .cs-social-buttons {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .cs-social-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      min-height: 52px;
      border: 1px solid var(--color-border-input);
      border-radius: 999px;
      padding: 0 16px;
      color: var(--color-text-secondary);
      background: var(--color-surface-input);
      cursor: pointer;
      font: inherit;
      font-size: 0.84rem;
      font-weight: 720;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
      transition: border-color 180ms ease, background 180ms ease, transform 180ms ease;
    }

    .cs-social-button:hover:not(:disabled) {
      border-color: var(--color-focus-ring);
      background: var(--color-surface-hover);
      transform: translateY(-1px);
    }

    .cs-social-button:disabled {
      cursor: wait;
      opacity: 0.52;
    }

    .cs-social-icon {
      width: 20px;
      height: 20px;
      flex: 0 0 auto;
    }

    .cs-social-discord-icon {
      color: #5865f2;
    }

    .cs-social-error {
      margin: 0;
      color: var(--color-warning-text);
      font-size: 0.82rem;
      line-height: 1.4;
    }

    .cs-note,
    .cs-error {
      margin: 14px 0 0;
      color: rgba(225, 234, 242, 0.58);
      font-size: 0.92rem;
      line-height: 1.45;
    }

    .cs-error {
      color: var(--color-warning-text);
    }

    .cs-r1 { animation: cs-rise 0.88s cubic-bezier(0.16, 1, 0.3, 1) 0.06s both; }
    .cs-r2 { animation: cs-rise 0.88s cubic-bezier(0.16, 1, 0.3, 1) 0.16s both; }
    .cs-r3 { animation: cs-rise 0.88s cubic-bezier(0.16, 1, 0.3, 1) 0.28s both; }
    .cs-r4 { animation: cs-rise 0.88s cubic-bezier(0.16, 1, 0.3, 1) 0.4s both; }
    .cs-r5 { animation: cs-rise 0.88s cubic-bezier(0.16, 1, 0.3, 1) 0.52s both; }

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

      .cs-button,
      .cs-field {
        width: 100%;
      }

      .cs-social-buttons {
        grid-template-columns: 1fr;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .tourney-page *,
      .tourney-page *::before,
      .tourney-page *::after,
      .cs-page *,
      .cs-page *::before,
      .cs-page *::after {
        animation: none !important;
        transition: none !important;
      }
    }
  `}</style>
);

export const LockScreen = ({
  error,
  heading = "Sign in.",
  subtitle = "Use your tourney account.",
  note = "Assigned accounts only.",
  buttonLabel = "Sign in",
  redirectTo = "/tourney",
  socialLogin = null,
}) => (
  <>
    <TourneyTelemetry />
    <LockStyles />
    <main className="cs-page">
      <div className="cs-shell">
        <section className="cs-core" aria-labelledby="tourney-login-title">
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
          <h1 id="tourney-login-title" className="cs-heading cs-r3">
            {heading}
          </h1>
          <p className="cs-subtitle cs-r4">{subtitle}</p>
          <form className="cs-login cs-r5" action="/api/tourney/login" method="post">
            <input type="hidden" name="redirectTo" value={redirectTo} />
            <input
              className="cs-field"
              name="username"
              type="text"
              autoComplete="username"
              placeholder="Discord username or email"
              aria-label="Discord username or email"
              required
            />
            <input
              className="cs-field"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Password"
              aria-label="Password"
              required
            />
            <label className="cs-remember">
              <input name="rememberMe" type="checkbox" value="on" />
              <span>Remember me</span>
            </label>
            <button className="cs-button" type="submit">
              {buttonLabel}
            </button>
          </form>
          {socialLogin}
          {error ? (
            <p className="cs-error cs-r5" role="alert">
              {error === "rate"
                ? "Too many attempts. Please try again later."
                : error === "suspended"
                  ? "You have been suspended from the tourney. Please contact serviroo through Discord or at serviroo@rooindustries.com for further queries."
                  : error === "unlinked"
                    ? "That Google or Discord email is not linked to an approved Tourney account. Use your username or email and password."
                    : ["unavailable", "exchange_failed", "missing_code"].includes(error)
                      ? "Social sign-in is temporarily unavailable. Use your username or email and password."
                  : "Invalid Discord username, email, or password. Wait for approval before trying to log in."}
            </p>
          ) : (
            <p className="cs-note cs-r5">{note}</p>
          )}
          <p className="cs-note cs-r5">
            <a href="/tourney/forgot">Forgot password?</a>
          </p>
        </section>
      </div>
    </main>
  </>
);

export const TourneyNav = ({ session, activeHref = "" }) => (
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
        <nav className="tourney-links" aria-label="Tournament sections">
          {getNavItems(session).map((item) => {
            const isActive = item.href === activeHref;
            return (
              <a
                key={item.href}
                href={item.href}
                className={isActive ? "is-active" : undefined}
                aria-current={isActive ? "page" : undefined}
              >
                {item.label}
              </a>
            );
          })}
        </nav>
        <TourneyThemeToggle />
        <details className="tourney-mobile-menu">
          <summary
            className="tourney-mobile-trigger"
            aria-label="Tournament navigation"
          >
            <span className="tourney-menu-bars" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="tourney-sr-only">Tournament navigation</span>
          </summary>
          <nav className="tourney-mobile-panel" aria-label="Tournament menu">
            {getNavItems(session).map((item) => {
              const isActive = item.href === activeHref;
              return (
                <a
                  key={item.href}
                  href={item.href}
                  className={isActive ? "is-active" : undefined}
                  aria-current={isActive ? "page" : undefined}
                >
                  {item.label}
                </a>
              );
            })}
          </nav>
        </details>
        {session ? (
          <div className="tourney-session">
            <form action="/api/tourney/logout" method="post">
              <button className="tourney-logout" type="submit">
                Sign out
              </button>
            </form>
          </div>
        ) : (
          <div className="tourney-session">
            <a className="tourney-login-link" href="/tourney/login">
              Sign in
            </a>
          </div>
        )}
      </div>
    </div>
  </header>
);

export const RouteTitle = ({ eyebrow, title, accent, children }) => (
  <section className="tourney-route-title" aria-labelledby="tourney-route-title">
    {eyebrow ? <span className="tourney-sr-only">{eyebrow}</span> : null}
    <h1 id="tourney-route-title">
      <span className="tourney-title-line">{title}</span>
      {accent ? (
        <span className="tourney-title-line tourney-title-accent">{accent}</span>
      ) : null}
    </h1>
    {children ? <p>{children}</p> : null}
  </section>
);

export const TourneyShell = ({ session, activeHref = "", children, wide = false }) => (
  <>
    <TourneyTelemetry />
    <TourneyStyles />
    <div
      id="app-shell"
      className="tourney-page relative min-h-screen flex flex-col overflow-hidden bg-scroll md:bg-fixed"
    >
      <div className="app-bg-grid-layer absolute inset-0" />
      <div className="app-bg-radial-layer absolute inset-0" />
      <main className="relative z-10 flex flex-col flex-1">
        <TourneyNav session={session} activeHref={activeHref} />
        <div className={wide ? "tourney-shell is-wide" : "tourney-shell"}>
          {children}
        </div>
        <TourneyFooter />
      </main>
    </div>
  </>
);
