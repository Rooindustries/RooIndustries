import React from "react";
import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import Services from "../components/Services";
import { getPublicContent } from "../lib/publicContentClient";
import { loadContent } from "../lib/contentCache";

jest.mock("../lib/publicContentClient", () => {
  const getPublicContent = jest.fn();
  return {
    getPublicContent,
    getPublicContentEntry: jest.fn(async (...args) => ({ data: await getPublicContent(...args), revision: null })),
  };
});

jest.mock("../lib/cmsImageUrl", () => ({
  urlFor: jest.fn(() => ({
    width() {
      return this;
    },
    url() {
      return "";
    },
  })),
}));

const CACHED_SERVICES = {
  heading: "Cached services heading",
  subheading: "Cached services subheading",
  cards: [],
  benchPages: [],
};

const CACHED_ABOUT = {
  recordTitle: "3DMark Hall of Fame",
  recordDetails: [{ label: "RANK", value: "#31" }],
};

describe("home section hydration", () => {
  let container;
  let root;
  let originalIntersectionObserver;

  beforeEach(() => {
    originalIntersectionObserver = global.IntersectionObserver;
    global.IntersectionObserver = class IntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root.unmount());
      root = null;
    }
    container.remove();
    global.IntersectionObserver = originalIntersectionObserver;
    jest.restoreAllMocks();
  });

  test("defers cached client data until after the server fallback hydrates", async () => {
    const page = <MemoryRouter><Services initialData={null} /></MemoryRouter>;
    container.innerHTML = renderToString(page);
    expect(container.querySelector(".ri-services-skeleton").closest("[data-section-placeholder]")).not.toBeNull();
    getPublicContent.mockImplementation(async (resource) =>
      resource === "services" ? CACHED_SERVICES : CACHED_ABOUT
    );
    await loadContent("services");
    await loadContent("about");
    const errorSpy = jest.spyOn(console, "error");

    try {
      await act(async () => {
        root = hydrateRoot(container, page);
        await Promise.resolve();
      });
    } catch (error) {
      throw error?.errors?.[0] || error;
    }

    expect(
      container.querySelector(".ri-services-heading")
    ).toBeInTheDocument();
    expect(
      container.querySelector(".ri-services-skeleton")
    ).not.toBeInTheDocument();
    const hydrationErrors = errorSpy.mock.calls.filter((args) =>
      args.some((value) =>
        /hydration failed|did not match|minified react error #418/i.test(
          String(value)
        )
      )
    );
    expect(hydrationErrors).toEqual([]);
  });
});
