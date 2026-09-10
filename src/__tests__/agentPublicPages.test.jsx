import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import About from "../legacyPages/About";
import Contact from "../components/Contact";
import Privacy from "../components/PrivacyPolicy";
import SeoFallback from "../next/SeoFallback";
import { ABOUT_PARAGRAPHS, CONTACT_GUIDANCE, CONTACT_EMAIL } from "../lib/companyContent";
import seo from "../lib/seo";
import routes from "../lib/routes";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

jest.mock("@formspree/react", () => ({
  useForm: () => [{ succeeded: false, submitting: false, errors: null }, jest.fn()],
  ValidationError: () => null,
}));

describe("Public company content", () => {
  test("requires an explicit target before making endpoint requests", () => {
    const env = { ...process.env };
    delete env.BASE_URL;
    const result = spawnSync(process.execPath, ["--test", "tests/agent-readiness.test.mjs"], {
      cwd: path.join(__dirname, "../.."),
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("BASE_URL is required");
  });

  test("renders an About page with a heading, substantial content, and working route metadata", () => {
    const html = renderToStaticMarkup(<MemoryRouter><About /></MemoryRouter>);
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.querySelector("h1").textContent).toBe("About Roo Industries");
    expect(ABOUT_PARAGRAPHS.join(" ").length).toBeGreaterThan(500);
    expect(document.querySelector("article").textContent).toContain(ABOUT_PARAGRAPHS[0]);
    expect(document.querySelector('a[href="/contact"]')).not.toBeNull();
    expect(document.querySelector('footer a[href="/about"]')).not.toBeNull();
    expect(routes.INDEXABLE_ROUTES).toContain("/about");
    expect(seo.getMetadataForPath("/about").alternates.canonical).toBe("https://www.rooindustries.com/about");
    expect(seo.getMetadataForPath("/about").robots.index).toBe(true);
  });

  test("renders contact guidance and its existing form before effects run", () => {
    const html = renderToStaticMarkup(<Contact />);
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.querySelector("h1").textContent).toBe("Get In Touch");
    expect(CONTACT_GUIDANCE.join(" ").length).toBeGreaterThan(500);
    for (const paragraph of CONTACT_GUIDANCE) expect(document.body.textContent).toContain(paragraph);
    expect(document.querySelector('form input[name="email"]')).not.toBeNull();
    expect(document.body.textContent).toContain(CONTACT_EMAIL);
  });

  test("renders the supplied privacy policy before any browser fetch", () => {
    const initialData = {
      title: "Privacy Policy",
      sections: [{
        heading: "Contact details",
        content: [{ _key: "contact", _type: "block", style: "normal", markDefs: [], children: [{ _key: "text", _type: "span", marks: [], text: "Contact serviroo@rooindustries.com about your information." }] }],
      }],
    };
    const html = renderToStaticMarkup(<Privacy initialData={initialData} />);
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.querySelector("h1").textContent).toBe("Privacy Policy");
    expect(document.querySelector("h2").textContent).toBe("Contact details");
    expect(document.querySelector(`a[href="mailto:${CONTACT_EMAIL}"]`)).not.toBeNull();
  });

  test.each(["/", "/contact", "/privacy"])("does not prepend a duplicate fallback heading on %s", (pathname) => {
    expect(renderToStaticMarkup(<SeoFallback pathname={pathname} />)).toBe("");
  });

  test("publishes a support contact without inventing a postal address", () => {
    const organization = seo.buildOrganizationJsonLd();
    expect(organization["@type"]).toBe("Organization");
    expect(organization.contactPoint).toEqual({
      "@type": "ContactPoint",
      email: CONTACT_EMAIL,
      contactType: "customer support",
      url: "https://www.rooindustries.com/contact",
    });
    expect(organization).not.toHaveProperty("address");
  });

  test("keeps llms.txt in the published title, summary, then H2 file-list format", () => {
    const text = fs.readFileSync(path.join(process.cwd(), "public/llms.txt"), "utf8");
    expect(text).toMatch(/^# Roo Industries\n\n> .+/);
    expect(text.match(/^# /gm)).toHaveLength(1);
    expect(text).toContain("## When to use this");
    expect(text).toContain("Accept: text/markdown");
    expect(text).toContain(CONTACT_EMAIL);
    for (const section of text.split(/^## /m).slice(1)) {
      for (const line of section.split("\n").slice(1).filter(Boolean)) {
        expect(line).toMatch(/^- \[[^\]]+\]\(https:\/\/www\.rooindustries\.com\/[^)]*\): .+/);
      }
    }
  });
});
