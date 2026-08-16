"use client";

import { track } from "@vercel/analytics/react";
import { FaBolt, FaDiscord } from "react-icons/fa";

const TOURNEY_CTA_EVENT = "tourney_cta_click";
const TOURNEY_CAMPAIGN = "losers_day";

const getTourneySurface = (pathname = "") => {
  if (pathname === "/tourney/bracket") return "bracket";
  if (pathname === "/tourney/roster") return "roster";
  return "tourney_home";
};

const ensureAnalyticsQueue = () => {
  if (typeof window === "undefined" || window.va) return;
  window.va = (...args) => {
    window.vaq = window.vaq || [];
    window.vaq.push(args);
  };
};

const trackTourneyCta = (cta) => {
  try {
    ensureAnalyticsQueue();
    track(TOURNEY_CTA_EVENT, {
      campaign: TOURNEY_CAMPAIGN,
      cta,
      surface: getTourneySurface(window.location.pathname),
    });
  } catch {
    // Analytics must never interfere with the visitor's navigation.
  }
};

export default function TourneyPromotionLinks() {
  return (
    <div className="tourney-hero-cta">
      <a
        className="is-primary"
        href="https://rooindustries.com/#packages"
        onClick={() => trackTourneyCta("boost_fps")}
      >
        <span className="tourney-hero-cta-label">
          <FaBolt aria-hidden="true" />
          <span>Boost Your FPS</span>
        </span>
        <small className="tourney-creator-proof">
          Vouched for by your favorite content creators like Vulture, Wanted,
          and more.
        </small>
      </a>
      <a
        className="is-secondary"
        href="https://discord.com/invite/qs5HKNyazD"
        onClick={() => trackTourneyCta("giveaway")}
        rel="noopener noreferrer"
        target="_blank"
      >
        <FaDiscord aria-hidden="true" />
        <span>Stand a Chance to Win $1,500 in Prizes</span>
      </a>
    </div>
  );
}
