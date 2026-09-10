/** @jest-environment node */

import { NextRequest } from "next/server";
import { middleware } from "../../middleware";
import { GET as getMarkdown } from "../../app/content.md/route";
import { GET as getMissing } from "../../app/not-found.md/route";
import sanityServer from "../lib/sanityServer";

jest.mock("../lib/sanityServer", () => ({ fetchPrivacyPolicy: jest.fn() }));

const request = (pathname, accept, options = {}) => new NextRequest(
  `https://www.rooindustries.com${pathname}`,
  { ...options, headers: { ...(accept === undefined ? {} : { accept }), ...options.headers } }
);

describe("Markdown content negotiation", () => {
  test.each([
    [undefined, "html"],
    ["*/*", "html"],
    ["text/*", "html"],
    ["text/html", "html"],
    ["text/markdown", "markdown"],
    ["TEXT/MARKDOWN; charset=utf-8", "markdown"],
    ["text/markdown;q=0.9, text/html;q=0.3", "markdown"],
    ["text/markdown;q=0.2, text/html;q=0.9", "html"],
    ["text/markdown;q=0, text/html", "html"],
    ["text/markdown;q=0, */*;q=0.5", "html"],
    ["text/html;q=0, text/*;q=0.5", "markdown"],
    ["text/*;q=0.8, text/html;q=0.2", "markdown"],
    ["text/html, text/markdown", "html"],
    ["text/markdown, text/html", "markdown"],
    ["text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8", "html"],
  ])("selects %s as %s", (accept, expected) => {
    const response = middleware(request("/", accept));
    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
    if (expected === "markdown") {
      expect(response.headers.get("x-middleware-rewrite")).toBe("https://www.rooindustries.com/content.md?path=%2F");
    } else {
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
  });

  test.each(["application/json", "", "text/html;q=0,text/markdown;q=0", "text/markdown; charset=iso-8859-1"])("rejects unsupported %s", (accept) => {
    const response = middleware(request("/", accept));
    expect(response.status).toBe(406);
    expect(response.headers.get("vary")).toContain("Accept");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");
  });

  test.each(["/", "/about", "/contact", "/privacy"])("negotiates HEAD for %s", async (path) => {
    expect(middleware(request(path, "text/markdown", { method: "HEAD" })).headers.get("x-middleware-rewrite")).toContain("/content.md?");
    const response = middleware(request(path, "application/json", { method: "HEAD" }));
    expect(response.status).toBe(406);
    expect(await response.text()).toBe("");
  });

  test.each([
    ["/api/content/contact", {}],
    ["/api/payment/create", { method: "POST" }],
    ["/", { method: "POST" }],
    ["/", { headers: { rsc: "1" } }],
    ["/", { headers: { "next-router-state-tree": "[]" } }],
  ])("preserves framework and API requests for %s", (path, options) => {
    const response = middleware(request(path, "text/markdown", options));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  test("retains privacy redirects ahead of negotiation", () => {
    const response = middleware(request("/?email=private&ref=partner", "text/markdown"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://www.rooindustries.com/?ref=partner");
  });

  test("leaves known routes to the router and marks only the missing-page representation", () => {
    const response = middleware(request("/downloads/utilities", "text/markdown"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-request-x-roo-missing-format")).toBe("markdown");
    const browser = middleware(request("/missing", "text/html", { headers: { "x-roo-missing-format": "markdown" } }));
    expect(browser.headers.get("x-middleware-request-x-roo-missing-format")).toBeNull();
  });
});

describe("Markdown responses", () => {
  test.each(["/", "/about", "/contact"])("returns readable content at %s", async (path) => {
    const response = await getMarkdown(request(`/content.md?path=${encodeURIComponent(path)}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toMatch(/^# /);
    expect(text.length).toBeGreaterThan(500);
    expect(text).not.toMatch(/<script|<!doctype|<html/i);
  });

  test("renders the published privacy policy and returns 503 during an outage", async () => {
    sanityServer.fetchPrivacyPolicy.mockResolvedValueOnce({
      title: "Privacy Policy",
      sections: [{ heading: "Collection", content: [{ _type: "block", children: [{ text: "We collect contact details." }] }] }],
    });
    const response = await getMarkdown(request("/content.md?path=/privacy"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("We collect contact details\\.");
    sanityServer.fetchPrivacyPolicy.mockRejectedValueOnce(new Error("unavailable"));
    expect((await getMarkdown(request("/content.md?path=/privacy"))).status).toBe(503);
    sanityServer.fetchPrivacyPolicy.mockResolvedValueOnce(null);
    expect((await getMarkdown(request("/content.md?path=/privacy"))).status).toBe(503);
  });

  test("returns a real 404 with recovery links, including for unlisted content", async () => {
    for (const response of [getMissing(), await getMarkdown(request("/content.md?path=/payment"))]) {
      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).toMatch(/^# 404/);
      expect(text).toContain("https://www.rooindustries.com/sitemap.xml");
      expect(text).toContain("https://www.rooindustries.com/llms.txt");
      expect(text).toContain("https://www.rooindustries.com/contact");
    }
  });
});
