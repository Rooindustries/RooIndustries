const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { INDEXABLE_ROUTES, NOINDEX_ROUTES } = require("../lib/routes");

const withEnv = (env, inspect) => {
  const previous = { ...process.env };
  try {
    delete process.env.VERCEL_ENV;
    delete process.env.NEXT_PUBLIC_VERCEL_ENV;
    Object.assign(process.env, env);
    jest.isolateModules(() => inspect(require("../lib/seo")));
  } finally {
    process.env = previous;
  }
};

it("keeps public and private route indexing policies consistent", () => {
  withEnv({ VERCEL_ENV: "production" }, (seo) => {
    for (const route of INDEXABLE_ROUTES) {
      expect(seo.getMetadataForPath(route).robots.index).toBe(true);
    }
    for (const route of NOINDEX_ROUTES) {
      expect(seo.getMetadataForPath(route).robots.index).toBe(false);
    }
    expect(seo.getMetadataForPath("/upgrade/private-order").robots.index).toBe(
      false,
    );
    expect(
      seo.getMetadataForPath("/downloads/private-order").robots.index,
    ).toBe(false);
  });
});

it.each(["preview", "development"])(
  "prevents indexing in %s deployments",
  (VERCEL_ENV) => {
    withEnv({ VERCEL_ENV, NODE_ENV: "production" }, (seo) => {
      for (const route of INDEXABLE_ROUTES)
        expect(seo.getMetadataForPath(route).robots.index).toBe(false);
    });
  },
);

it("does not mark local development as production when deployment variables are absent", () => {
  withEnv({ NODE_ENV: "development" }, (seo) => {
    expect(seo.getMetadataForPath("/").robots.index).toBe(false);
  });
});

it("generates stable sitemap entries matching canonical URLs and excludes private routes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roo-sitemap-"));
  const env = {
    ...process.env,
    NEXT_PUBLIC_SITE_URL: "https://www.example.com",
    SITE_URL: "https://old.example.com",
    VERCEL_ENV: "production",
    NODE_ENV: "production",
  };
  fs.mkdirSync(path.join(directory, "public"));
  const generate = (script) =>
    execFileSync(
      process.execPath,
      [path.resolve(__dirname, "../../scripts", script)],
      { cwd: directory, env },
    );
  try {
    generate("generate-sitemap.js");
    const sitemap = fs.readFileSync(
      path.join(directory, "public/sitemap.xml"),
      "utf8",
    );
    generate("generate-sitemap.js");
    expect(
      fs.readFileSync(path.join(directory, "public/sitemap.xml"), "utf8"),
    ).toBe(sitemap);
    expect(sitemap).not.toMatch(
      /lastmod|changefreq|priority|old\.example\.com/,
    );
    for (const route of INDEXABLE_ROUTES)
      expect(sitemap).toContain(
        `<loc>https://www.example.com${route === "/" ? "" : route}</loc>`,
      );
    for (const route of NOINDEX_ROUTES)
      expect(sitemap).not.toContain(
        `<loc>https://www.example.com${route}</loc>`,
      );
    generate("generate-robots.js");
    expect(
      fs.readFileSync(path.join(directory, "public/robots.txt"), "utf8"),
    ).toContain("Sitemap: https://www.example.com/sitemap.xml");
    env.VERCEL_ENV = "preview";
    generate("generate-robots.js");
    expect(
      fs.readFileSync(path.join(directory, "public/robots.txt"), "utf8"),
    ).toBe("User-agent: *\nDisallow: /\n");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
