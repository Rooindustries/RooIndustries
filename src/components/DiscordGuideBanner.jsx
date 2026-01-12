import React, { useEffect, useState } from "react";
import { FaDiscord } from "react-icons/fa";
import { client } from "../sanityClient";

const DEFAULT_BANNER = {
  text: "Free optimization guide in our Discord",
  mobileText: "Free guide in Discord",
  link: "https://discord.gg/M7nTkn9dxE",
};

export default function DiscordGuideBanner({ hidden = false }) {
  const [banner, setBanner] = useState(DEFAULT_BANNER);

  useEffect(() => {
    let mounted = true;
    client
      .fetch(`*[_type == "discordBanner"][0]{text, mobileText, link}`)
      .then((data) => {
        if (!mounted || !data) return;
        setBanner((prev) => ({
          text: data.text || prev.text,
          mobileText: data.mobileText || prev.mobileText,
          link: data.link || prev.link,
        }));
      })
      .catch(console.error);
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div
      className={`w-full overflow-hidden bg-gradient-to-r from-cyan-500/20 via-sky-500/25 to-cyan-500/20 transition-all duration-500 ease-in-out ${
        hidden
          ? "max-h-0 opacity-0 -translate-y-2 border-transparent"
          : "max-h-24 opacity-100 translate-y-0 border-b border-cyan-300/25"
      }`}
      aria-hidden={hidden ? "true" : undefined}
    >
      <a
        href={banner.link || DEFAULT_BANNER.link}
        target="_blank"
        rel="noreferrer"
        className={`group flex w-full items-center justify-center gap-2 px-4 py-2.5 sm:py-3 text-sm sm:text-base font-semibold text-cyan-50 transition hover:bg-cyan-400/15 ${
          hidden ? "pointer-events-none" : "pointer-events-auto"
        }`}
        aria-label={banner.text || DEFAULT_BANNER.text}
        tabIndex={hidden ? -1 : 0}
      >
        <FaDiscord className="text-base sm:text-lg" aria-hidden="true" />
        <span className="hidden sm:inline">
          {banner.text || DEFAULT_BANNER.text}
        </span>
        <span className="sm:hidden">
          {banner.mobileText || banner.text || DEFAULT_BANNER.mobileText}
        </span>
        <span
          className="text-cyan-200 transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        >
          -&gt;
        </span>
      </a>
    </div>
  );
}
