import React, { useEffect, useMemo, useState } from "react";
import { client, urlFor } from "../sanityClient";

const HEX_CLIP_PATH = "circle(50% at 50% 50%)";

const fallbackData = {
  seoTitle: "Meet The Team | Roo Industries",
  seoDescription: "The crew behind your performance gains.",
  heroTitle: "Meet The Team",
  heroSubtitle: "The crew behind your performance gains.",
  showFounder: true,
  founder: {
    badgeText: "Global Record Holder",
    name: "serviroo",
    title: "Founder & Lead Optimizer",
    bio: "World record holder in overclocking. Built Roo Industries from the ground up to help others squeeze every last frame from their hardware.",
    stats: [
      { value: "200+", label: "Clients" },
      { value: "WR", label: "Holder" },
    ],
    tags: ["BIOS", "RAM", "Windows", "XOC", "OC"],
    socialLinks: [
      {
        label: "@serviroo",
        url: "https://twitter.com/serviroo",
        icon: "x",
      },
    ],
  },
  sections: [
    {
      title: "Core Team",
      variant: "standard",
      cards: [
        {
          name: "Nerky",
          title: "Lead Developer",
          bio: "Builds the tools that power the operation.",
          tags: ["JS", "CSS"],
        },
        {
          name: "Exyy",
          title: "Junior Developer",
          bio: "Learning the ropes, shipping code.",
          tags: ["JS", "CSS"],
        },
        {
          name: "Cal",
          title: "Lead Support",
          bio: "First point of contact. Keeps the community running smooth.",
          tags: ["Community", "Operations"],
        },
        {
          name: "Bun",
          title: "Creative Director",
          bio: "The mind behind the look. Turns ideas into pixels.",
          tags: ["CSS", "Design", "Strategy"],
        },
        {
          name: "Kaisen",
          title: "Windows Specialist",
          bio: "Knows Windows inside out. OS optimization down to the registry.",
          tags: ["Windows", "OS Tuning"],
        },
      ],
    },
    {
      title: "PR & Marketing",
      variant: "standard",
      cards: [
        {
          name: "Wailshark",
          title: "Marketing Specialist",
          bio: "Uni student by day, brand builder by night.",
          tags: ["Marketing", "Strategy"],
        },
        {
          name: "Tempered",
          title: "Lead PR",
          bio: "Semi-pro Apex Legends player. Handles comms.",
          tags: ["PR", "Apex Legends"],
        },
      ],
    },
    {
      title: "Brand Ambassadors",
      variant: "ambassador",
      cards: [
        {
          name: "SkinzOW",
          title: "Ambassador / Streamer",
          bio: "Grandmaster Overwatch 2 player.",
          platformBadge: "TWITCH",
          ctaLabel: "Watch Live",
          ctaUrl: "https://twitch.tv/skinzow",
        },
        {
          name: "VultureOW",
          title: "Ambassador / Creator",
          bio: "Top 500 player. Known for Junkrat plays.",
          platformBadge: "TWITCH",
          ctaLabel: "Watch Live",
          ctaUrl: "https://twitch.tv/Vulture_ow",
        },
        {
          name: "Josh369",
          title: "Ambassador / Streamer",
          bio: "Top 500 Bastion main.",
          platformBadge: "TWITCH",
          ctaLabel: "Watch Live",
          ctaUrl: "https://twitch.tv/Josh369",
        },
      ],
    },
  ],
  footer: {
    note: "Want to join our community?",
    buttonText: "Join Our Discord",
    buttonUrl: "https://discord.gg/M7nTkn9dxE",
    showDiscordIcon: true,
  },
};

const buildImageUrl = (image, size) => {
  if (!image) return "";
  try {
    return urlFor(image).width(size).height(size).fit("crop").url();
  } catch {
    return "";
  }
};

const getInitials = (value) => {
  if (!value || typeof value !== "string") return "?";
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] || "";
  const second = parts.length > 1 ? parts[1][0] || "" : "";
  return `${first}${second}`.toUpperCase();
};

const isExternalUrl = (url) => /^https?:\/\//i.test(url || "");

const getLinkProps = (url) => {
  if (!url) return {};
  if (isExternalUrl(url)) {
    return { target: "_blank", rel: "noreferrer" };
  }
  return {};
};

const SocialIcon = ({ type }) => {
  switch (type) {
    case "twitch":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" />
        </svg>
      );
    case "discord":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
        </svg>
      );
    case "link":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M10.59 13.41a1.996 1.996 0 0 1 0-2.82l2.83-2.83a2 2 0 1 1 2.83 2.83l-1.06 1.06a1 1 0 1 1-1.41-1.41l1.06-1.06a.5.5 0 0 0-.71-.71l-2.83 2.83a.5.5 0 0 0 0 .71 1 1 0 0 1-1.41 1.41z" />
          <path d="M13.41 10.59a1.996 1.996 0 0 1 0 2.82l-2.83 2.83a2 2 0 1 1-2.83-2.83l1.06-1.06a1 1 0 1 1 1.41 1.41l-1.06 1.06a.5.5 0 0 0 .71.71l2.83-2.83a.5.5 0 0 0 0-.71 1 1 0 0 1 1.41-1.41z" />
        </svg>
      );
    case "x":
    default:
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      );
  }
};

const AvatarHex = ({
  image,
  alt,
  initials,
  sizeClassName,
  accentClassName,
  placeholderClassName,
}) => {
  const imageUrl = buildImageUrl(image, 400);
  const clipStyle = { clipPath: HEX_CLIP_PATH };

  return (
    <div className={`relative ${sizeClassName}`}>
      <div className={`absolute inset-0 ${accentClassName}`} style={clipStyle} />
      <div
        className="absolute inset-[3px] bg-gradient-to-br from-[#1a2332] to-[#0d1525]"
        style={clipStyle}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={alt}
            className="h-full w-full object-cover"
            style={clipStyle}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div
            className={`flex h-full w-full items-center justify-center ${placeholderClassName}`}
            style={clipStyle}
          >
            {initials}
          </div>
        )}
      </div>
    </div>
  );
};

const Tag = ({ label, size = "sm" }) => {
  const baseClasses =
    "inline-flex items-center rounded border border-cyan-300/30 bg-cyan-400/10 text-cyan-200";
  const sizeClasses =
    size === "lg"
      ? "px-3 py-1 text-xs font-semibold tracking-wide"
      : "px-2.5 py-1 text-[11px] font-medium";
  return <span className={`${baseClasses} ${sizeClasses}`}>{label}</span>;
};

export default function MeetTheTeam({ onSeoData }) {
  const [rawData, setRawData] = useState(null);

  useEffect(() => {
    client
      .fetch(
        `*[_type == "meetTheTeam"][0]{
          seoTitle,
          seoDescription,
          heroTitle,
          heroSubtitle,
          showFounder,
          founder{
            badgeText,
            name,
            title,
            bio,
            avatar,
            stats[]{_key, value, label},
            tags,
            socialLinks[]{_key, label, url, icon}
          },
          sections[]{
            _key,
            title,
            variant,
            cards[]{
              _key,
              name,
              title,
              bio,
              avatar,
              initials,
              tags,
              platformBadge,
              ctaLabel,
              ctaUrl
            }
          },
          footer{
            note,
            buttonText,
            buttonUrl,
            showDiscordIcon
          }
        }`
      )
      .then(setRawData)
      .catch(console.error);
  }, []);

  const resolved = useMemo(() => {
    const source = rawData || {};
    const founderSource = source.founder || {};
    const founderFallback = fallbackData.founder;

    const statsSource = Array.isArray(founderSource.stats)
      ? founderSource.stats.filter((stat) => stat?.value || stat?.label)
      : [];
    const tagsSource = Array.isArray(founderSource.tags)
      ? founderSource.tags.filter(Boolean)
      : [];
    const socialSource = Array.isArray(founderSource.socialLinks)
      ? founderSource.socialLinks.filter((link) => link?.url)
      : [];

    const sectionsSource = Array.isArray(source.sections)
      ? source.sections.filter((section) => section)
      : [];

    const sections =
      sectionsSource.length > 0 ? sectionsSource : fallbackData.sections;

    return {
      seoTitle: source.seoTitle || fallbackData.seoTitle,
      seoDescription: source.seoDescription || fallbackData.seoDescription,
      heroTitle: source.heroTitle || fallbackData.heroTitle,
      heroSubtitle: source.heroSubtitle || fallbackData.heroSubtitle,
      showFounder:
        typeof source.showFounder === "boolean"
          ? source.showFounder
          : fallbackData.showFounder,
      founder: {
        badgeText: founderSource.badgeText || founderFallback.badgeText,
        name: founderSource.name || founderFallback.name,
        title: founderSource.title || founderFallback.title,
        bio: founderSource.bio || founderFallback.bio,
        avatar: founderSource.avatar || null,
        stats: statsSource.length > 0 ? statsSource : founderFallback.stats,
        tags: tagsSource.length > 0 ? tagsSource : founderFallback.tags,
        socialLinks:
          socialSource.length > 0 ? socialSource : founderFallback.socialLinks,
      },
      sections,
      footer: {
        note: source.footer?.note || fallbackData.footer.note,
        buttonText: source.footer?.buttonText || fallbackData.footer.buttonText,
        buttonUrl: source.footer?.buttonUrl || fallbackData.footer.buttonUrl,
        showDiscordIcon:
          typeof source.footer?.showDiscordIcon === "boolean"
            ? source.footer.showDiscordIcon
            : fallbackData.footer.showDiscordIcon,
      },
    };
  }, [rawData]);

  useEffect(() => {
    if (typeof onSeoData !== "function") return;
    onSeoData({
      title: resolved.seoTitle,
      description: resolved.seoDescription,
    });
  }, [onSeoData, resolved.seoDescription, resolved.seoTitle]);

  const renderedSections = useMemo(() => {
    return resolved.sections
      .map((section) => {
        const cards = Array.isArray(section.cards)
          ? section.cards.filter((card) => card?.name || card?.title || card?.bio)
          : [];
        return {
          ...section,
          cards,
          variant: section.variant || "standard",
        };
      })
      .filter((section) => section.cards.length > 0);
  }, [resolved.sections]);

  const hasFooterCta = Boolean(
    resolved.footer.note || resolved.footer.buttonText || resolved.footer.buttonUrl
  );

  return (
    <section className="w-full text-white">
      <div className="w-full bg-gradient-to-b from-[#0a0f1a] to-[#0d1525]">
        {/* Hero */}
        <div className="px-5">
          <div className="mx-auto max-w-6xl text-center pt-20 pb-16 relative">
            <h1 className="text-4xl sm:text-5xl font-bold bg-gradient-to-br from-white to-cyan-300 bg-clip-text text-transparent">
              {resolved.heroTitle}
            </h1>
            {resolved.heroSubtitle && (
              <p className="mt-4 text-lg text-slate-400 max-w-[520px] mx-auto">
                {resolved.heroSubtitle}
              </p>
            )}
          </div>
        </div>

        {/* Founder */}
        {resolved.showFounder && resolved.founder?.name && (
          <div className="px-5">
            <div className="mx-auto max-w-6xl py-10">
              <div className="flex justify-center">
                <div className="relative w-full max-w-[600px] rounded-2xl border border-cyan-300/20 bg-white/[0.03] px-8 py-10 text-center transition-all duration-300 hover:-translate-y-1 hover:border-cyan-300/50 hover:shadow-[0_20px_40px_rgba(0,212,255,0.1)]">
                  {resolved.founder.badgeText && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-br from-cyan-300 to-sky-500 px-5 py-1 text-[11px] font-bold uppercase tracking-[0.2em] text-[#0a0f1a]">
                      {resolved.founder.badgeText}
                    </span>
                  )}
                  <div className="mx-auto mb-5 flex justify-center">
                    <AvatarHex
                      image={resolved.founder.avatar}
                      alt={resolved.founder.name}
                      initials={getInitials(resolved.founder.name)}
                      sizeClassName="h-[120px] w-[120px]"
                      accentClassName="bg-gradient-to-br from-cyan-300 to-sky-600"
                      placeholderClassName="text-2xl font-bold text-cyan-300"
                    />
                  </div>
                  <div className="text-[28px] font-bold">
                    {resolved.founder.name}
                  </div>
                  {resolved.founder.title && (
                    <div className="text-cyan-300 text-sm font-medium mt-1">
                      {resolved.founder.title}
                    </div>
                  )}
                  {resolved.founder.bio && (
                    <p className="mt-4 text-slate-400 text-base">
                      {resolved.founder.bio}
                    </p>
                  )}
                  {resolved.founder.stats?.length > 0 && (
                    <div className="mt-6 flex flex-wrap justify-center gap-10">
                      {resolved.founder.stats.map((stat, index) => (
                        <div
                          key={stat?._key || `${stat?.value}-${index}`}
                          className="text-center"
                        >
                          <div className="text-2xl font-bold text-cyan-300">
                            {stat?.value}
                          </div>
                          <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                            {stat?.label}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {resolved.founder.tags?.length > 0 && (
                    <div className="mt-5 flex flex-wrap justify-center gap-2">
                      {resolved.founder.tags.map((tag, index) => (
                        <Tag key={`${tag}-${index}`} label={tag} size="lg" />
                      ))}
                    </div>
                  )}
                  {resolved.founder.socialLinks?.length > 0 && (
                    <div className="mt-5 flex flex-wrap justify-center gap-3">
                      {resolved.founder.socialLinks.map((link, index) => {
                        const linkLabel = link?.label || link?.url;
                        if (!link?.url || !linkLabel) return null;
                        return (
                          <a
                            key={link?._key || `${linkLabel}-${index}`}
                            href={link.url}
                            {...getLinkProps(link.url)}
                            className="inline-flex items-center gap-2 rounded-md bg-white/5 px-4 py-2 text-sm text-slate-300 transition-all duration-200 hover:bg-cyan-400/10 hover:text-cyan-200"
                          >
                            <SocialIcon type={link?.icon || "x"} />
                            {linkLabel}
                          </a>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Sections */}
        {renderedSections.map((section, sectionIndex) => {
          const isAmbassador = section.variant === "ambassador";
          return (
            <div key={section._key || `${section.title}-${sectionIndex}`}>
              <div className="px-5">
                <div className="mx-auto max-w-6xl py-10">
                  {section.title && (
                    <div className="text-center mb-10">
                      <h2 className="text-2xl font-semibold uppercase tracking-[0.2em] text-cyan-300">
                        {section.title}
                      </h2>
                      <div className="mx-auto mt-3 h-0.5 w-16 bg-gradient-to-r from-transparent via-cyan-300 to-transparent" />
                    </div>
                  )}
                  <div className="flex flex-wrap justify-center gap-6">
                    {section.cards.map((card, cardIndex) => {
                      const initials = card?.initials
                        ? card.initials.slice(0, 2).toUpperCase()
                        : getInitials(card?.name || "");
                      if (isAmbassador) {
                        return (
                          <div
                            key={card?._key || `${card?.name}-${cardIndex}`}
                            className="relative w-full max-w-[300px] rounded-xl border border-purple-400/30 bg-white/[0.02] px-6 py-7 text-center transition-all duration-300 hover:-translate-y-1 hover:border-purple-400/60 hover:shadow-[0_12px_30px_rgba(145,70,255,0.15)]"
                          >
                            {card?.platformBadge && (
                              <span className="absolute top-4 right-4 rounded bg-purple-500 px-2.5 py-1 text-[10px] font-semibold tracking-[0.2em] text-white">
                                {card.platformBadge}
                              </span>
                            )}
                            <div className="mx-auto mb-4 flex justify-center">
                              <AvatarHex
                                image={card?.avatar}
                                alt={card?.name || "Team member"}
                                initials={initials}
                                sizeClassName="h-[90px] w-[90px]"
                                accentClassName="bg-gradient-to-br from-[#9146ff] to-[#6633cc]"
                                placeholderClassName="text-xl font-bold text-cyan-300"
                              />
                            </div>
                            <div className="text-xl font-semibold">
                              {card?.name}
                            </div>
                            {card?.title && (
                              <div className="mt-1 text-xs font-medium text-purple-300">
                                {card.title}
                              </div>
                            )}
                            {card?.bio && (
                              <p className="mt-3 text-sm text-slate-400">
                                {card.bio}
                              </p>
                            )}
                            {card?.ctaLabel && card?.ctaUrl && (
                              <a
                                href={card.ctaUrl}
                                {...getLinkProps(card.ctaUrl)}
                                className="mt-5 inline-flex items-center gap-2 rounded-md bg-purple-500 px-5 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-purple-600 hover:scale-[1.02]"
                              >
                                <SocialIcon type="twitch" />
                                {card.ctaLabel}
                              </a>
                            )}
                          </div>
                        );
                      }

                      return (
                        <div
                          key={card?._key || `${card?.name}-${cardIndex}`}
                          className="w-full max-w-[300px] rounded-xl border border-white/10 bg-white/[0.02] px-6 py-7 text-center transition-all duration-300 hover:-translate-y-1 hover:border-cyan-300/40 hover:shadow-[0_12px_30px_rgba(0,0,0,0.3)]"
                        >
                          <div className="mx-auto mb-4 flex justify-center">
                            <AvatarHex
                              image={card?.avatar}
                              alt={card?.name || "Team member"}
                              initials={initials}
                              sizeClassName="h-[90px] w-[90px]"
                              accentClassName="bg-gradient-to-br from-cyan-300 to-sky-600"
                              placeholderClassName="text-xl font-bold text-cyan-300"
                            />
                          </div>
                          <div className="text-xl font-semibold">
                            {card?.name}
                          </div>
                          {card?.title && (
                            <div className="mt-1 text-xs font-medium text-cyan-300">
                              {card.title}
                            </div>
                          )}
                          {card?.bio && (
                            <p className="mt-3 text-sm text-slate-400 min-h-[40px]">
                              {card.bio}
                            </p>
                          )}
                          {Array.isArray(card?.tags) && card.tags.length > 0 && (
                            <div className="mt-4 flex flex-wrap justify-center gap-2">
                              {card.tags.map((tag, tagIndex) => (
                                <Tag key={`${tag}-${tagIndex}`} label={tag} />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Footer CTA */}
        {hasFooterCta && (
          <div className="px-5">
            <div className="mx-auto max-w-6xl py-16 text-center">
              {resolved.footer.note && (
                <p className="text-sm text-slate-500">
                  {resolved.footer.note}
                </p>
              )}
              {resolved.footer.buttonText && resolved.footer.buttonUrl && (
                <a
                  href={resolved.footer.buttonUrl}
                  {...getLinkProps(resolved.footer.buttonUrl)}
                  className="mt-5 inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-cyan-300 to-sky-500 px-7 py-3 text-sm font-semibold text-[#0a0f1a] transition-all duration-200 hover:-translate-y-1 hover:shadow-[0_8px_20px_rgba(0,212,255,0.3)]"
                >
                  {resolved.footer.showDiscordIcon && (
                    <SocialIcon type="discord" />
                  )}
                  {resolved.footer.buttonText}
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
