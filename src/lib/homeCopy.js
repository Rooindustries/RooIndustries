const HOME_COPY = {
  hero: {
    tagline: "",
    headingLine1: "More FPS. Less Input Lag.",
    headingLine2: "Tuned For Ranked Games.",
    description:
      "We tune BIOS, Windows, memory, GPU, and game settings around the games you actually play, so ranked feels smoother, FPS climbs, and the mouse does what your hand tells it to.",
    subtext:
      "You bring the PC and the game list. We tune it, test it, and show the before and after.",
    ctaPrimaryText: "Tune My PC",
    ctaSecondaryText: "How It Works",
    ctaNote:
      "Former #16 3DMark HOF · Lifetime warranty",
    bullets: [
      "20-92% FPS gains shown in reviews",
      "Lower input lag for ranked games",
      "Cleaner 1% lows and fewer spikes",
      "Same-day slots when open",
    ],
  },
  services: {
    heading: "Built For Ranked Games",
    subheading:
      "Stock settings leave FPS sitting idle in hardware you already paid for. We put it back into your games: more FPS, lower delay, cleaner frametimes.",
    cards: [
      {
        iconType: "clock",
        title: "Lower delay",
        description:
          "Polling, drivers, power, and game settings get lined up so the mouse tracks closer to your hand.",
      },
      {
        iconType: "zap",
        title: "Stable frames",
        description:
          "1% lows and frametimes get tightened so fights feel smooth and the FPS counter matches it.",
      },
      {
        iconType: "shield",
        title: "More FPS",
        description:
          "BIOS, Windows, GPU, RAM, and in-game settings tuned around the titles you play most.",
      },
      {
        iconType: "wrench",
        title: "Less junk running",
        description:
          "Cleaner startup, lighter overlays, better storage, and power behavior that leaves more room for the game.",
      },
      {
        iconType: "video",
        title: "OBS setup",
        description:
          "OBS, encoder, and capture settings are built around the game first, so clips and streams feel clean.",
      },
      {
        iconType: "cpu",
        title: "FPS stays up",
        description:
          "Heat, boost, RAM, and stability get dialed in so the PC keeps pace deep into the session.",
      },
    ],
  },
  reviews: {
    title: "Results Players Felt",
    subtitle:
      "The FPS graph matters. The real test is whether ranked feels cleaner after the tune.",
  },
  howItWorks: {
    title: "How It Works",
    subtitle: "PC Optimization made easy in 4 steps",
    steps: [
      {
        badge: "Step 1",
        title: "Schedule an Optimization",
        text:
          "Tell us your setup and goal (ranked, content creation, or smoother gameplay). Pick a time - we'll handle the rest.",
      },
      {
        badge: "Step 2",
        title: "Prepare for Greatness",
        text:
          "We send a quick prep checklist - 30 minutes max. After that, we can tune around the games you care about.",
      },
      {
        badge: "Step 3",
        title: "Unleash Your Hardware",
        text:
          "We tune BIOS, Windows, and game configs for your rig and overclock it for smoother frametimes, higher 1% lows, lower input lag.",
      },
      {
        badge: "Step 4",
        title: "Verify & Deliver",
        text:
          "We run benchmarks, show the before & after performance, and hand you a settings summary along with warranty support.",
      },
    ],
  },
  supportedGames: {
    title: "For The Games You Grind",
    subtitle:
      "Shooters, battle royales, racing sims, MMOs, stream setups. If FPS matters there, it counts.",
    showAllLabel: "View All Games",
    showLessLabel: "Show Less",
  },
  packagesSettings: {
    heading: "Lock In More FPS",
    badgeText: "Remote Sessions",
    subheading:
      "Start with game settings, go deeper into Windows and BIOS, or book the full pass when you want more FPS and smoother ranked games. Before you price a new GPU: a tune costs a fraction of one, and the 20-92% gains in our reviews rival an upgrade.",
    dividerText: "Book it, send specs, pay, get the session details by email.",
  },
  faqSettings: {
    eyebrow: "Before we touch your setup",
    title: "Questions Players Ask First",
    subtitle:
      "FPS, input lag, warranty, remote access, safety, and what happens during the session.",
  },
};

const keyed = (sourceItems = [], canonicalItems = []) =>
  canonicalItems.map((item, index) => ({
    ...item,
    _key: sourceItems[index]?._key || item._key || `copy-${index}`,
  }));

const applyHeroCopyOverride = (value = {}) => ({
  ...value,
  ...HOME_COPY.hero,
});

const applyHomeSectionCopyOverride = (key, value) => {
  if (key === "reviews") {
    return {
      ...(value || {}),
      title: HOME_COPY.reviews.title,
      subtitle: HOME_COPY.reviews.subtitle,
    };
  }

  if (key === "services") {
    return {
      ...(value || {}),
      heading: HOME_COPY.services.heading,
      subheading: HOME_COPY.services.subheading,
      benchAfterLabel: "After Tune",
      cards: keyed(value?.cards, HOME_COPY.services.cards),
    };
  }

  if (key === "how-it-works") {
    const hasSourceSteps = Array.isArray(value?.steps) && value.steps.length > 0;

    return {
      ...(value || {}),
      title: value?.title || HOME_COPY.howItWorks.title,
      subtitle: value?.subtitle || HOME_COPY.howItWorks.subtitle,
      steps: hasSourceSteps
        ? value.steps
        : keyed(value?.steps, HOME_COPY.howItWorks.steps),
    };
  }

  if (key === "supported-games") {
    return {
      ...(value || {}),
      ...HOME_COPY.supportedGames,
    };
  }

  if (key === "packages-settings") {
    return {
      ...(value || {}),
      ...HOME_COPY.packagesSettings,
    };
  }

  if (key === "faq-settings") {
    return {
      ...(value || {}),
      ...HOME_COPY.faqSettings,
    };
  }

  return value;
};

const applyHomePageCopyOverrides = (homeData = {}) => ({
  ...homeData,
  reviews: applyHomeSectionCopyOverride("reviews", homeData.reviews),
  services: applyHomeSectionCopyOverride("services", homeData.services),
  howItWorks: applyHomeSectionCopyOverride("how-it-works", homeData.howItWorks),
  supportedGames: applyHomeSectionCopyOverride(
    "supported-games",
    homeData.supportedGames
  ),
  packagesSettings: applyHomeSectionCopyOverride(
    "packages-settings",
    homeData.packagesSettings
  ),
  faqSettings: applyHomeSectionCopyOverride(
    "faq-settings",
    homeData.faqSettings
  ),
});

module.exports = {
  HOME_COPY,
  applyHeroCopyOverride,
  applyHomePageCopyOverrides,
  applyHomeSectionCopyOverride,
};
