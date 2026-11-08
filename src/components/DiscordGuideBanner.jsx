import React from "react";
import { FaDiscord } from "react-icons/fa";
import { useLocation } from "react-router-dom";
import { useContent } from "../lib/contentCache";
import { usePublicContent } from "../next/PublicContentContext";

const DEFAULT_BANNER = {
  text: "Free FPS tuning guide in Discord",
  mobileText: "Free guide in Discord",
  link: "https://discord.com/invite/qs5HKNyazD",
};

export default function DiscordGuideBanner({ hidden = false }) {
  const location = useLocation();
  const { discordBanner } = usePublicContent();
  const { data } = useContent("discord-banner", discordBanner, { refreshKey: location.pathname });
  const banner = { ...DEFAULT_BANNER, link: data?.link || DEFAULT_BANNER.link };

  return (
    <div
      className={`ri-discord-guide-banner w-full overflow-hidden bg-glass backdrop-blur-md shadow-[inset_0_-1px_0_var(--color-border-accent)] transition-all duration-500 ease-in-out ${
        hidden
          ? "max-h-0 opacity-0 -translate-y-2 border-transparent"
          : "max-h-24 opacity-100 translate-y-0 border-b border-transparent"
      }`}
      aria-hidden={hidden ? "true" : undefined}
    >
      <a
        href={banner.link || DEFAULT_BANNER.link}
        target="_blank"
        rel="noopener noreferrer"
        className={`ri-discord-guide-link group flex w-full items-center justify-center gap-2 px-4 py-2.5 sm:py-3 text-sm sm:text-base font-semibold text-info-text transition hover:bg-surface-hover-accent hover:text-[color:var(--color-link-hover)] ${
          hidden ? "pointer-events-none" : "pointer-events-auto"
        }`}
        tabIndex={hidden ? -1 : 0}
      >
        <FaDiscord className="text-base sm:text-lg" aria-hidden="true" />
        <span className="hidden sm:inline">
          {banner.text || DEFAULT_BANNER.text}
        </span>
        <span className="sm:hidden">
          {banner.mobileText || banner.text || DEFAULT_BANNER.mobileText}
        </span>
      </a>
    </div>
  );
}
