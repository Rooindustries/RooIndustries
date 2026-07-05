const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "https://www.rooindustries.com").replace(/\/$/, "");

const SITE_NAME = "Roo Industries";
const DEFAULT_OG_IMAGE = "/embed_logo.png";
const DEFAULT_DESCRIPTION =
  "Remote PC game optimization for competitive players who want more FPS, lower input lag, cleaner frametimes, and stable performance in the games they play.";

const routeMeta = {
  "/": {
    title: "Roo Industries | PC Game Optimization",
    description: DEFAULT_DESCRIPTION,
    noindex: false,
  },
  "/benchmarks": {
    title: "Benchmark Results | Roo Industries",
    description: "See before and after FPS numbers from real Roo Industries game tuning sessions.",
    noindex: false,
  },
  "/reviews": {
    title: "Client Reviews & Results | Roo Industries Performance Tuning",
    description:
      "Read how players describe the FPS gains, lower input lag, smoother mouse feel, and cleaner frametimes after real Roo Industries game tuning sessions online.",
    noindex: false,
  },
  "/faq": {
    title: "PC Game Optimization FAQ | Roo Industries",
    description:
      "Read the first questions players ask about FPS, input lag, booking, remote access, warranty, and what happens during the session.",
    noindex: false,
  },
  "/contact": {
    title: "Contact | Roo Industries",
    description: "Send your PC details, ask what package fits, or start a remote game tuning session.",
    noindex: false,
  },
  "/terms": {
    title: "Terms & Conditions | Roo Industries",
    description: "Read the terms and conditions for Roo Industries services.",
    noindex: false,
  },
  "/privacy": {
    title: "Privacy Policy | Roo Industries",
    description: "How Roo Industries collects, uses, and protects your data.",
    noindex: false,
  },
  "/meet-the-team": {
    title: "Meet The Team | Roo Industries",
    description:
      "Meet the people behind Roo Industries FPS tuning, BIOS work, Windows setup, and game-specific performance sessions.",
    noindex: false,
  },
  "/tools": {
    title: "Free PC Performance Tools & Downloads | Roo Industries",
    description:
      "Grab Roo Industries tools for benchmarks, prep checks, FPS testing, and PC performance notes before your remote tuning session starts around real games.",
    noindex: false,
  },
  "/packages": {
    title: "PC Game Optimization Packages | Roo Industries",
    description:
      "Compare packages for game settings, FPS tuning, Windows and BIOS work, input lag, and full PC performance tuning.",
    noindex: false,
  },
  "/tourney": {
    title: "Overwatch Creator Tournament | Roo Industries",
    description:
      "Roo Industries Overwatch Creator Tournament event information, rules, roster status, creator signups, charity details, giveaways, and bracket access for the 6v6 Legacy Series.",
    noindex: false,
  },
  "/booking": {
    title: "Book PC Game Tuning | Roo Industries",
    description: "Book the remote session, send specs, and lock in a time for your Roo Industries tuning session.",
    noindex: true,
  },
  "/payment": {
    title: "Complete Booking Payment | Roo Industries",
    description: "Finish payment and confirm the booking details for your Roo Industries session.",
    noindex: true,
  },
  "/payment-success": {
    title: "Payment Successful | Roo Industries",
    description:
      "Your Roo Industries payment was successful. Review your booking confirmation and next steps.",
    noindex: true,
  },
  "/thank-you": {
    title: "Thank You | Roo Industries",
    description: "Your booking is in. Roo Industries is getting the session details ready.",
    noindex: true,
  },
  "/upgrade-xoc": {
    title: "Upgrade to Performance Vertex Max | Roo Industries",
    description:
      "Check your order eligibility and upgrade to Performance Vertex Max with Roo Industries.",
    noindex: true,
  },
  "/referrals/login": {
    title: "Referral Partner Login | Roo Industries Performance Portal",
    description:
      "Sign in to your Roo Industries referral portal to track clicks, monitor conversions, review payout progress, and manage your active partner account securely.",
    noindex: false,
  },
  "/referrals/register": {
    title: "Referral Program Sign Up | Roo Industries Partner Access",
    description:
      "Create your Roo Industries referral partner account to get a unique tracking link, monitor conversions, and earn rewards for qualified customer referrals.",
    noindex: false,
  },
  "/referrals/dashboard": {
    title: "Referral Earnings Dashboard | Roo Industries Partner Portal",
    description:
      "View referral clicks, conversions, and payout totals in your Roo Industries dashboard, with secure access to your partner performance and reward activity.",
    noindex: true,
  },
  "/referrals/change-password": {
    title: "Change Referral Password | Roo Industries Secure Access",
    description:
      "Update your Roo Industries referral account password securely to protect payouts, tracking data, and account access before continuing in your dashboard.",
    noindex: true,
  },
  "/referrals/forgot": {
    title: "Forgot Referral Password | Roo Industries Account Recovery",
    description:
      "Start account recovery for your Roo Industries referral profile by requesting a secure reset link, then return to your dashboard and referral performance tools.",
    noindex: true,
  },
  "/referrals/reset": {
    title: "Reset Referral Account Password | Roo Industries Recovery",
    description:
      "Set a new secure password for your Roo Industries referral account so you can restore access, protect payouts, and continue managing partner performance.",
    noindex: true,
  },
  "/404": {
    title: "404 Page Not Found | Roo Industries PC Game Optimization",
    description:
      "That page is not here. Use the nav to get back to packages, reviews, tools, contact, or booking for Roo Industries game tuning, FPS results, and reviews.",
    noindex: true,
  },
};

const normalizePath = (value) => {
  if (!value || value === "/") return "/";
  const clean = value.split("?")[0].split("#")[0];
  return clean.endsWith("/") ? clean.slice(0, -1) : clean;
};

const isProd =
  (process.env.VERCEL_ENV || process.env.NEXT_PUBLIC_VERCEL_ENV || "production") ===
  "production";

const resolveCanonical = (pathname) => {
  const normalized = normalizePath(pathname);
  return normalized === "/" ? siteUrl : `${siteUrl}${normalized}`;
};

function buildMetadata({
  pathname,
  title,
  description,
  noindex = false,
  type = "website",
  image = DEFAULT_OG_IMAGE,
  imageAlt = "Roo Industries logo",
}) {
  const canonicalUrl = resolveCanonical(pathname);
  const normalizedPath = normalizePath(pathname);
  const forceNoIndex = !isProd || noindex;
  const imageUrl = image.startsWith("http") ? image : `${siteUrl}${image}`;

  return {
    metadataBase: new URL(siteUrl),
    title,
    description,
    applicationName: SITE_NAME,
    manifest: "/manifest.json",
    alternates: {
      canonical: canonicalUrl,
    },
    robots: forceNoIndex
      ? {
          index: false,
          follow: false,
          nocache: true,
        }
      : {
          index: true,
          follow: true,
        },
    openGraph: {
      title,
      description,
      type,
      siteName: SITE_NAME,
      url: canonicalUrl,
      images: [
        {
          url: imageUrl,
          width: 500,
          height: 500,
          alt: imageAlt,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
    other: {
      "twitter:image:alt": imageAlt,
      "canonical-path": normalizedPath,
    },
  };
}

function getMetadataForPath(pathname) {
  const normalized = normalizePath(pathname);
  if (normalized.startsWith("/upgrade/")) {
    return buildMetadata({
      pathname: normalized,
      title: "Upgrade Booking | Roo Industries",
      description:
        "Check your order details and continue your Roo Industries package upgrade securely.",
      noindex: true,
    });
  }

  const entry = routeMeta[normalized] || routeMeta["/404"];
  return buildMetadata({
    pathname: normalized,
    title: entry.title,
    description: entry.description,
    noindex: entry.noindex,
  });
}

const buildOrganizationJsonLd = () => ({
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": `${siteUrl}/#organization`,
  name: SITE_NAME,
  description: DEFAULT_DESCRIPTION,
  url: siteUrl,
  logo: `${siteUrl}${DEFAULT_OG_IMAGE}`,
  sameAs: ["https://discord.com/invite/qs5HKNyazD"],
  areaServed: "Worldwide",
});

const buildHomePageJsonLd = () => ({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${siteUrl}/#website`,
      name: SITE_NAME,
      url: siteUrl,
      publisher: {
        "@id": `${siteUrl}/#organization`,
      },
    },
    {
      "@type": "WebPage",
      "@id": `${siteUrl}/#webpage`,
      url: siteUrl,
      name: "Roo Industries | PC Game Optimization",
      headline: "More FPS. Less Input Lag. Tuned For Ranked Games.",
      description:
        "Roo Industries tunes BIOS, Windows, memory, GPU, and game settings around the games players actually play for smoother ranked games, higher FPS, lower input lag, and cleaner frametimes.",
      isPartOf: {
        "@id": `${siteUrl}/#website`,
      },
      publisher: {
        "@id": `${siteUrl}/#organization`,
      },
      mainEntity: {
        "@id": `${siteUrl}/#pc-game-optimization-service`,
      },
    },
    {
      "@type": "Service",
      "@id": `${siteUrl}/#pc-game-optimization-service`,
      name: "Remote PC Game Optimization",
      serviceType: "PC game optimization",
      url: siteUrl,
      provider: {
        "@id": `${siteUrl}/#organization`,
      },
      areaServed: "Worldwide",
      description:
        "Remote optimization for BIOS, Windows, memory, GPU, RAM, and in-game settings focused on FPS, input lag, frametime stability, and ranked-game performance.",
      hasOfferCatalog: {
        "@type": "OfferCatalog",
        name: "Roo Industries PC Game Optimization Packages",
        url: `${siteUrl}/packages`,
      },
    },
  ],
});

const buildOfferCatalogJsonLd = (name = "PC Game Optimization Services") => ({
  "@context": "https://schema.org",
  "@type": "OfferCatalog",
  name,
  itemListElement: [
    {
      "@type": "ListItem",
      position: 1,
      item: {
        "@type": "Service",
        name: "PC Game Optimization",
        description: "Tune BIOS, Windows, GPU, RAM, and game settings for higher FPS and smoother ranked games.",
      },
    },
    {
      "@type": "ListItem",
      position: 2,
      item: {
        "@type": "Service",
        name: "FPS Tuning",
        description: "Measure average FPS, 1% lows, and frametime spikes, then tune around the titles you play.",
      },
    },
    {
      "@type": "ListItem",
      position: 3,
      item: {
        "@type": "Service",
        name: "Input Lag Reduction",
        description: "Dial in Windows, drivers, power behavior, polling, and game settings for a cleaner mouse feel.",
      },
    },
    {
      "@type": "ListItem",
      position: 4,
      item: {
        "@type": "Service",
        name: "Competitive Game Settings",
        description: "Set up the PC around ranked play, not generic benchmark runs.",
      },
    },
    {
      "@type": "ListItem",
      position: 5,
      item: {
        "@type": "Service",
        name: "Streaming Performance Tuning",
        description: "Balance OBS, capture, encoder, and recording settings around the game first.",
      },
    },
    {
      "@type": "ListItem",
      position: 6,
      item: {
        "@type": "Service",
        name: "Overclocking",
        description: "CPU, GPU, and RAM tuning when it supports stable real-game performance.",
      },
    },
  ],
});

const buildFaqJsonLd = (items = []) => ({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: items
    .filter((item) => item?.question && item?.answer)
    .map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
});

const buildTourneyEventJsonLd = () => ({
  "@context": "https://schema.org",
  "@type": "Event",
  "@id": `${siteUrl}/tourney#event`,
  name: "Overwatch Creator Tournament: 6v6 Legacy Series",
  description:
    "Roo Industries Overwatch Creator Tournament with event information, rules, roster status, creator signups, charity details, giveaways, and bracket access.",
  url: `${siteUrl}/tourney`,
  startDate: "2026-08-15",
  endDate: "2026-08-16",
  eventStatus: "https://schema.org/EventScheduled",
  eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
  location: {
    "@type": "VirtualLocation",
    url: `${siteUrl}/tourney`,
  },
  organizer: {
    "@id": `${siteUrl}/#organization`,
    name: SITE_NAME,
    url: siteUrl,
  },
});

module.exports = {
  SITE_NAME,
  SITE_URL: siteUrl,
  routeMeta,
  normalizePath,
  resolveCanonical,
  buildMetadata,
  getMetadataForPath,
  buildOrganizationJsonLd,
  buildHomePageJsonLd,
  buildOfferCatalogJsonLd,
  buildFaqJsonLd,
  buildTourneyEventJsonLd,
};
