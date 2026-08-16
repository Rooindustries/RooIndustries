const HOME_COPY = {
  hero: {
    tagline: "",
    headingLine1: "More FPS. Less Input Lag.",
    headingLine2: "Tuned For Ranked Games.",
    description:
      "Your PC should feel as fast as you play. Get higher FPS, steadier 1% lows, and cleaner mouse response in the games you actually grind.",
    subtext:
      "One remote session. Real before-and-after results. No new hardware needed.",
    ctaPrimaryText: "Tune My PC",
    ctaSecondaryText: "How It Works",
    ctaNote:
      "Same-day sessions available · Before-and-after results · Lifetime warranty",
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
      "Everything that makes the game feel faster, smoother, and more consistent.",
    cards: [
      {
        iconType: "clock",
        title: "Lower delay",
        description:
          "Cleaner mouse response when every flick matters.",
      },
      {
        iconType: "zap",
        title: "Stable frames",
        description:
          "Stronger 1% lows through fights and team pushes.",
      },
      {
        iconType: "shield",
        title: "More FPS",
        description:
          "Unlock performance from the hardware you already own.",
      },
      {
        iconType: "wrench",
        title: "Less junk running",
        description:
          "Cut background load that steals frames from your game.",
      },
      {
        iconType: "video",
        title: "Stream-ready",
        description:
          "Stream and record without wrecking game performance.",
      },
      {
        iconType: "cpu",
        title: "FPS stays up",
        description:
          "Stable performance through long ranked sessions.",
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
      "Start with game settings or go all the way to BIOS. A tune costs a fraction of a new GPU, and the 20-92% gains in our reviews rival one.",
    dividerText: "Book it, send specs, pay, get the session details by email.",
  },
  faqSettings: {
    eyebrow: "Before we touch your setup",
    title: "Questions Players Ask First",
    subtitle:
      "FPS, input lag, warranty, remote access, safety, and what happens during the session.",
  },
};

const OVERWATCH_CREATOR_BENCHMARK = Object.freeze({
  gameTitle: "Overwatch 2",
  gameLogoUrl: "/overwatch-2-logo.svg",
  beforeFps: 200,
  afterFps: 450,
  gpu: "NVIDIA GeForce RTX 4080",
  cpu: "AMD Ryzen 9 7900X3D",
  ram: "32GB 6000MHz DDR5",
  metricLabel: "Avg FPS",
});

const withOverwatchCreatorBenchmark = (benchPages = []) => {
  const games = Array.isArray(benchPages)
    ? benchPages.flatMap((page) =>
        Array.isArray(page?.games) ? page.games.filter(Boolean) : []
      )
    : [];
  const remainingGames = games.filter(
    (game) => !/^overwatch(?:\s+2)?$/i.test(String(game?.gameTitle || "").trim())
  );
  const featuredGames = [OVERWATCH_CREATOR_BENCHMARK, ...remainingGames];

  return Array.from(
    { length: Math.ceil(featuredGames.length / 3) },
    (_, index) => ({ games: featuredGames.slice(index * 3, index * 3 + 3) })
  );
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
      benchPages: withOverwatchCreatorBenchmark(value?.benchPages),
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
  OVERWATCH_CREATOR_BENCHMARK,
  applyHeroCopyOverride,
  applyHomePageCopyOverrides,
  applyHomeSectionCopyOverride,
  withOverwatchCreatorBenchmark,
};
