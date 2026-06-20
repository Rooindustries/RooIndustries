export const SITE_NAME = "Roo Industries";
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.REACT_APP_SITE_URL ||
  "https://www.rooindustries.com").replace(/\/$/, "");
export const DEFAULT_TITLE = `${SITE_NAME} | PC Game Optimization`;
export const DEFAULT_DESCRIPTION =
  "Remote PC game optimization for competitive players who want more FPS, lower input lag, cleaner frametimes, and stable performance in the games they play.";
export const DEFAULT_OG_IMAGE = `${SITE_URL}/embed_logo.png`;
export const SAME_AS = ["https://discord.com/invite/qs5HKNyazD"];
export const AREA_SERVED = "Worldwide";

export const resolveUrl = (value) => {
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `${SITE_URL}${value.startsWith("/") ? "" : "/"}${value}`;
};

export const buildOrganizationJsonLd = () => ({
  "@context": "https://schema.org",
  "@type": "Organization",
  name: SITE_NAME,
  description: DEFAULT_DESCRIPTION,
  url: SITE_URL,
  logo: DEFAULT_OG_IMAGE,
  sameAs: SAME_AS,
  areaServed: AREA_SERVED,
});

export const SERVICE_LIST = [
  {
    name: "PC Game Optimization",
    description: "Tune BIOS, Windows, GPU, RAM, and game settings for higher FPS and smoother ranked games.",
  },
  {
    name: "FPS Tuning",
    description: "Measure average FPS, 1% lows, and frametime spikes, then tune around the titles you play.",
  },
  {
    name: "Input Lag Reduction",
    description: "Dial in Windows, drivers, power behavior, polling, and game settings for a cleaner mouse feel.",
  },
  {
    name: "Competitive Game Settings",
    description: "Set up the PC around ranked play, not generic benchmark runs.",
  },
  {
    name: "Streaming Performance Tuning",
    description: "Balance OBS, capture, encoder, and recording settings around the game first.",
  },
  {
    name: "Overclocking",
    description: "CPU, GPU, and RAM tuning when it supports stable real-game performance.",
  },
];

export const buildFAQPageJsonLd = (items = []) => ({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: items.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.answer,
    },
  })),
});

export const buildOfferCatalogJsonLd = (name = "PC Game Optimization Services") => ({
  "@context": "https://schema.org",
  "@type": "OfferCatalog",
  name,
  itemListElement: SERVICE_LIST.map((service, index) => ({
    "@type": "ListItem",
    position: index + 1,
    item: {
      "@type": "Service",
      name: service.name,
      description: service.description,
      areaServed: AREA_SERVED,
      provider: {
        "@type": "Organization",
        name: SITE_NAME,
        url: SITE_URL,
      },
    },
  })),
});
