---
name: roo-navbar-regression-guard
description: Guard RooIndustries navbar, logo, favicon and header-glass changes against visual and navigation regressions.
---

# Roo navbar regression guard

Use the current checkout. Read `src/components/Navbar.jsx`, `src/index.css`,
`tests/section-nav.spec.js` and `tests/nav-chaos.spec.js` before changing the header.

Keep these invariants:

- The small static logo, animated logo and their wrapper have transparent edges and backgrounds.
- Desktop navigation stays on one row. The mobile menu and Proof menu still open, close and navigate.
- In-page links, route changes, Back and Forward preserve the selected section and scroll position.
- Reduced motion keeps a usable static logo. Animation must not add layout shift.

The navbar currently uses `public/favicon-96x96.png` and
`public/logo-animated-small.webp`. Inspect its actual `src` values when assets
change; the retained APNG is not the navbar's animated source.

Run the existing fixture-backed suites from the repository root:

```bash
(
  set -e
  while IFS= read -r key; do
    case "$key" in SENTRY_DSN|*_SENTRY_DSN) unset "$key" ;; esac
  done < <(compgen -e)
  browser_prefix=()
  if [[ $(uname -s) == Linux && -z ${DISPLAY:-} ]]; then
    browser_prefix=(xvfb-run -a)
  fi
  env -u BASE_URL -u NEXT_DIST_DIR -u PW_SERVER_ID \
    "${browser_prefix[@]}" ./node_modules/.bin/playwright test \
    tests/section-nav.spec.js tests/nav-chaos.spec.js --project=chromium --reporter=line
)
```

This clears inherited Sentry DSNs and fixture IDs, then invokes Playwright
directly so `playwright.config.js` starts a separate local fixture for each
process. The `npm run test:nav:*` wrappers synthesize `BASE_URL` and assume
an already running server; use the direct command for this check.
Linux sessions without `DISPLAY` use `xvfb-run`, matching CI; install the same
browser/display prerequisites.
Use a free `PW_PORT` and `ROO_TEST_HOST` for this checkout when other tests run.
The suites cover navigation and desktop layout; they do not prove logo pixel
transparency. Check rendered logos, computed wrapper styles and asset alpha at
360 px, 390 px and desktop widths, with animation and reduced motion. Save
before/after screenshots and a short interaction recording with the task's
artifacts. A screenshot alone does not establish alpha transparency.

Finish only when those checks pass. Follow the task's shipping authorization;
this skill adds no permission to merge or deploy.
