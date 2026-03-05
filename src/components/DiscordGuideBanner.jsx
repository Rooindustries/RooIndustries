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
      className={`w-full overflow-hidden bg-gradient-to-r from-[#061a31]/88 via-[#0a2b46]/78 to-[#061a31]/88 backdrop-blur-md shadow-[inset_0_-1px_0_rgba(103,232,249,0.07)] transition-all duration-500 ease-in-out ${
        hidden
          ? "max-h-0 opacity-0 -translate-y-2 border-transparent"
          : "max-h-24 opacity-100 translate-y-0 border-b border-transparent"
      }`}
      aria-hidden={hidden ? "true" : undefined}
    >
      <a
        href={banner.link || DEFAULT_BANNER.link}
        target="_blank"
        rel="noreferrer"
        className={`group flex w-full items-center justify-center gap-2 px-4 py-2.5 sm:py-3 text-sm sm:text-base font-semibold text-cyan-50/88 transition hover:bg-cyan-300/8 hover:text-cyan-100 ${
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
      </a>
    </div>
  );
}
