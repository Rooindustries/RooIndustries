const packageContent = require("../lib/packageContent");
const packagePricing = require("../lib/packagePricing");

const {
  WINDOWS_REOPTIMIZATION_LABEL,
  applyPackageContentOverrides,
  applyPackagesContentOverrides,
  normalizeFaqQuestions,
} = packageContent;
const {
  TOP_PACKAGE_PUBLIC_TITLE,
  applyPackagePricing,
  applyPackagesPricing,
  getPackagePricePresentation,
  getPackageTitleAliases,
  normalizePackageTitleForMatch,
} = packagePricing;

describe("top package normalization", () => {
  test("renames legacy XOC package and prices it at $99.95", () => {
    const pkg = applyPackagePricing({
      title: "XOC / Extreme Overclocking",
      price: "$149.95",
    });

    expect(pkg.title).toBe(TOP_PACKAGE_PUBLIC_TITLE);
    expect(pkg.sourceTitle).toBe("XOC / Extreme Overclocking");
    expect(pkg.price).toBe("$99.95");
    expect(pkg.compareAtPrice).toBe("$149.95");
  });

  test("resolves old and new top package aliases to the same title", () => {
    expect(normalizePackageTitleForMatch("XOC / Extreme Overclocking")).toBe(
      "performance vertex max"
    );
    expect(normalizePackageTitleForMatch("Performance Vertex Max")).toBe(
      "performance vertex max"
    );
    expect(getPackageTitleAliases("Performance Vertex Max")).toEqual(
      expect.arrayContaining(["Performance Vertex Max", "XOC / Extreme Overclocking"])
    );
  });

  test("keeps old source prices mapped to the new $99.95 price", () => {
    expect(
      getPackagePricePresentation("Performance Vertex Max", "$149.95")
    ).toEqual({
      price: "$99.95",
      compareAtPrice: "$149.95",
      hasOverride: true,
    });

    expect(
      getPackagePricePresentation("XOC / Extreme Overclocking", "$179.95")
    ).toEqual({
      price: "$99.95",
      compareAtPrice: "$149.95",
      hasOverride: true,
    });
  });
});

describe("package content normalization", () => {
  test("applies canonical checklist rows across all package cards", () => {
    const packages = applyPackagesContentOverrides(
      applyPackagesPricing([
        {
          title: "Vertex Essentials",
          price: "$49.95",
          checkedBullets: ["Windows Optimization"],
          uncheckedBullets: ["Free Reoptimization"],
        },
        {
          title: "Performance Vertex Overhaul",
          price: "$79.95",
          checkedBullets: ["Windows Optimization"],
          uncheckedBullets: ["Free Reoptimization"],
        },
        {
          title: "XOC",
          price: "$179.95",
          buttonText: "Book XOC",
          checkedBullets: ["Free Reoptimization"],
          uncheckedBullets: [],
          features: ["Future upgrade path - free reoptimizations"],
        },
      ])
    );

    const essentials = packages[0];
    const overhaul = packages[1];
    const max = packages[2];
    const rendered = JSON.stringify(packages);

    expect(rendered).not.toMatch(/free reoptimization/i);
    expect(essentials.checkedBullets).toHaveLength(3);
    expect(overhaul.checkedBullets).toHaveLength(6);
    expect(max.checkedBullets).toHaveLength(9);
    expect(essentials.checkedBullets.length + essentials.uncheckedBullets.length).toBe(
      9
    );
    expect(overhaul.checkedBullets.length + overhaul.uncheckedBullets.length).toBe(
      9
    );
    expect(max.checkedBullets.length + max.uncheckedBullets.length).toBe(9);
    expect(essentials.checkedBullets).toEqual(
      expect.arrayContaining([
        "Windows system tuning",
        "Hidden BIOS tuning",
        "Game settings tuning",
      ])
    );
    expect(essentials.checkedBullets).not.toContain("90 day support");
    expect(essentials.checkedBullets).not.toContain("Lifetime warranty support");
    expect(essentials.uncheckedBullets).toEqual(
      expect.arrayContaining([
        "CPU GPU RAM tuning",
        "Fan curve tuning",
        "Driver latency tuning",
        "Extensive hardware tuning",
        "SQM router setup",
        "6-month Windows reoptimization",
      ])
    );
    expect(essentials.uncheckedBullets).not.toContain("90 day support");
    expect(essentials.uncheckedBullets).not.toContain(
      "Lifetime warranty support"
    );
    expect(overhaul.checkedBullets).toEqual(
      expect.arrayContaining([
        "CPU GPU RAM tuning",
        "Fan curve tuning",
        "Driver latency tuning",
      ])
    );
    expect(overhaul.checkedBullets).not.toContain("90 day support");
    expect(overhaul.checkedBullets).not.toContain("Lifetime warranty support");
    expect(overhaul.uncheckedBullets).toEqual(
      expect.arrayContaining([
        "Extensive hardware tuning",
        "SQM router setup",
        "6-month Windows reoptimization",
      ])
    );
    expect(overhaul.uncheckedBullets).not.toContain(
      "Lifetime warranty support"
    );
    expect(max.title).toBe(TOP_PACKAGE_PUBLIC_TITLE);
    expect(max.price).toBe("$99.95");
    expect(max.buttonText).toBe("Book Now");
    expect(max.checkedBullets).toEqual(
      expect.arrayContaining([
        "CPU GPU RAM tuning",
        "Fan curve tuning",
        "Driver latency tuning",
        "Extensive hardware tuning",
        "SQM router setup",
        "6-month Windows reoptimization",
      ])
    );
    expect(max.checkedBullets).not.toContain("90 day support");
    expect(max.checkedBullets).not.toContain("Lifetime warranty support");
    expect(max.uncheckedBullets).toEqual([]);
    expect(max.features.join(" ")).toContain("Lifetime warranty");
    expect(max.features.join(" ")).toContain("24-hour response target");
  });

  test("replaces free reoptimization with Windows reoptimization", () => {
    const pkg = applyPackageContentOverrides({
      title: "Performance Vertex Max",
      checkedBullets: ["Lifetime Warranty", "Free Reoptimization"],
      uncheckedBullets: null,
      features: [
        "Future upgrade path — free reoptimizations upon upgrading components or entire PC every 6 months",
        "Lifetime warranty with guaranteed 24 hour response",
      ],
    });

    expect(pkg.checkedBullets).toContain("6-month Windows reoptimization");
    expect(pkg.checkedBullets).not.toContain("Lifetime warranty support");
    expect(pkg.checkedBullets.join(" ")).not.toMatch(/free reoptimization/i);
    expect(pkg.features.join(" ")).toContain(WINDOWS_REOPTIMIZATION_LABEL);
    expect(pkg.features.join(" ")).not.toMatch(/free reoptimizations/i);
    expect(pkg.features.join(" ")).toContain("Lifetime warranty");
  });

  test("rewrites FAQ rows that mention free reoptimization or reXOC", () => {
    const rows = normalizeFaqQuestions([
      {
        question: "What does free reoptimization mean?",
        answer: "Free reoptimization means XOC users can reXOC the entire PC.",
      },
      {
        question: "What if I want to change a part before the 6-month period?",
        answer: "No problem at all — a one-time $50 fee applies for a reXOC.",
      },
    ]);

    expect(rows[0].question).toBe(
      "What does Windows reoptimization every 6 months mean?"
    );
    expect(rows[0].answer).toContain("Windows-side optimization");
    expect(rows[0].answer).toContain("Performance Vertex Max");
    expect(rows[0].answer).toContain("I can redo");
    expect(rows[1].question).toBe(
      "What if I change a part before the 6-month period?"
    );
    expect(rows[1].answer).toContain("message me first");
    expect(rows[1].answer).toContain("paid support sessions");

    const rendered = JSON.stringify(rows);
    expect(rendered).not.toMatch(/contact Roo Industries/i);
    expect(rendered).not.toMatch(/Roo Industries can/i);
    expect(rendered).not.toMatch(/free reoptimization/i);
    expect(rendered).not.toMatch(/reXOC/i);
  });
});
