const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "https://www.rooindustries.com").replace(/\/$/, "");

const SITE_NAME = "Roo Industries";
const DEFAULT_OG_IMAGE = "/embed_logo.png";

const routeMeta = {
  "/": {
    title: "Roo Industries | Professional PC Optimization",
    description:
      "World-class PC optimization, BIOS tuning, and game performance boosts delivered fully online.",
    noindex: false,
  },
  "/benchmarks": {
    title: "Benchmark Results | Roo Industries",
    description:
      "See real before-and-after FPS gains from Roo Industries optimizations.",
    noindex: false,
  },
  "/reviews": {
    title: "Client Reviews & Results | Roo Industries Performance Tuning",
    description:
      "Read verified Roo Industries client reviews covering FPS gains, latency improvements, and system stability results from professional PC optimization sessions.",
    noindex: false,
  },
  "/faq": {
    title: "PC Optimization FAQ | Roo Industries",
    description:
      "Read Roo Industries answers on PC optimization, BIOS tuning, booking, upgrades, warranties, and what to expect from a professional tuning session.",
    noindex: false,
  },
  "/contact": {
    title: "Contact | Roo Industries",
    description:
      "Get in touch to start your PC optimization or ask a question.",
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
      "Meet the Roo Industries specialists behind your optimization sessions, from diagnostics and BIOS tuning to game-specific performance engineering.",
    noindex: false,
  },
  "/tools": {
    title: "Free PC Tools & Downloads | Roo Industries Optimization Hub",
    description:
      "Access free Roo Industries tools and downloads to benchmark performance, support diagnostics, and prepare your system for safe optimization sessions online.",
    noindex: false,
  },
  "/packages": {
    title: "PC Optimization Packages | Roo Industries Performance Plans",
    description:
      "Compare Roo Industries optimization packages, service inclusions, and pricing to choose the right performance tuning plan for your PC and gaming goals.",
    noindex: false,
  },
  "/booking": {
    title: "Book PC Optimization Session | Roo Industries",
    description:
      "Schedule your Roo Industries optimization session and lock in your preferred tuning window online.",
    noindex: true,
  },
  "/payment": {
    title: "Complete Booking Payment | Roo Industries",
    description:
      "Finish your secure Roo Industries booking payment and confirm your scheduled optimization session details.",
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
    description:
      "Thank you for booking with Roo Industries. We are preparing your optimization session details.",
    noindex: true,
  },
  "/upgrade-xoc": {
    title: "Upgrade to XOC | Roo Industries",
    description:
      "Check your order eligibility and upgrade to XOC / Extreme Overclocking with Roo Industries.",
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
    title: "404 Page Not Found | Roo Industries PC Optimization Services",
    description:
      "The page you requested is unavailable. Explore Roo Industries services, reviews, tools, and support to continue improving your PC performance online today.",
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
  name: SITE_NAME,
  url: siteUrl,
  logo: `${siteUrl}${DEFAULT_OG_IMAGE}`,
  sameAs: ["https://discord.gg/M7nTkn9dxE"],
  areaServed: "Worldwide",
});

const buildOfferCatalogJsonLd = (name = "Optimization Services") => ({
  "@context": "https://schema.org",
  "@type": "OfferCatalog",
  name,
  itemListElement: [
    {
      "@type": "ListItem",
      position: 1,
      item: {
        "@type": "Service",
        name: "PC Optimization",
        description: "System-wide performance and stability tuning.",
      },
    },
    {
      "@type": "ListItem",
      position: 2,
      item: {
        "@type": "Service",
        name: "BIOS Optimization",
        description: "Safe BIOS configuration and stability testing.",
      },
    },
    {
      "@type": "ListItem",
      position: 3,
      item: {
        "@type": "Service",
        name: "Game Optimization",
        description: "Per-title settings to maximize FPS and consistency.",
      },
    },
    {
      "@type": "ListItem",
      position: 4,
      item: {
        "@type": "Service",
        name: "Overclocking",
        description: "CPU, GPU, and RAM tuning with stability checks.",
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

module.exports = {
  SITE_NAME,
  SITE_URL: siteUrl,
  routeMeta,
  normalizePath,
  resolveCanonical,
  buildMetadata,
  getMetadataForPath,
  buildOrganizationJsonLd,
  buildOfferCatalogJsonLd,
  buildFaqJsonLd,
};
