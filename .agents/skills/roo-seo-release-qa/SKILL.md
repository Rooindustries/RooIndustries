---
name: roo-seo-release-qa
description: Verify RooIndustries crawlability, metadata and server-rendered content before a release.
---

# Roo SEO release QA

Read `src/lib/routes.js`, `src/lib/seo.js`, `scripts/check-seo.js` and
`tests/nonjs-seo.spec.js` for the current route and metadata contract. Include
the static `public/BIOSGuide/` page, Markdown variants, `public/llms.txt`,
generated sitemap and robots rules when the change reaches them.

Run from the assigned checkout with a free test port. Leave `BASE_URL` unset;
the Playwright config starts an isolated fixture and blocks public-site tests.

```bash
npm run check:seo
npm run test:seo:nonjs -- --project=chromium --reporter=line
npm run test:seo:structured-data -- --project=chromium --reporter=line
```

Use `ROO_TEST_HOST` and `PW_PORT` to select this checkout's local test endpoint.
Save command results and Playwright artifacts under the task's artifact path.
The fixture suite builds its own test server; do not point it at production.
If release criteria require a separate production build, run it once after the
last code change with the repo's documented validation environment.

Check each affected indexable route's title, description, canonical, robots
policy, rendered heading/content and structured data. Compare the route list
to sitemap entries; redirects, admin routes and private flows should not
accidentally become indexable. Preserve static rendering and existing
revalidation behavior. A passing metadata check alone does not prove SSR or
cache behavior.

On failure, repair the affected layer and rerun its check. Follow the task's
shipping criteria; passing this checklist alone does not authorize deployment.
