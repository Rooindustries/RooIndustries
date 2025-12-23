export const SITE_NAME = "Roo Industries";
export const SITE_URL = (process.env.REACT_APP_SITE_URL ||
  "https://www.rooindustries.com").replace(/\/$/, "");
export const DEFAULT_TITLE = `${SITE_NAME} | Professional PC Optimization`;
export const DEFAULT_DESCRIPTION =
  "World-class PC optimization, BIOS tuning, and game performance boosts delivered fully online.";
export const DEFAULT_OG_IMAGE = `${SITE_URL}/embed_logo.png`;
export const SAME_AS = ["https://discord.gg/M7nTkn9dxE"];
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
  url: SITE_URL,
  logo: DEFAULT_OG_IMAGE,
  sameAs: SAME_AS,
  areaServed: AREA_SERVED,
});

export const SERVICE_LIST = [
  {
    name: "PC Optimization",
    description: "System-wide performance and stability tuning.",
  },
  {
    name: "BIOS Optimization",
    description: "Safe BIOS configuration and stability testing.",
  },
  {
    name: "Game Optimization",
    description: "Per-title settings to maximize FPS and consistency.",
  },
  {
    name: "Overclocking",
    description: "CPU, GPU, and RAM tuning with stability checks.",
  },
];

export const buildOfferCatalogJsonLd = (name = "Optimization Services") => ({
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
