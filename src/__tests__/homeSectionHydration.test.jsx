import React from "react";
import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import Services from "../components/Services";

jest.mock("../sanityClient", () => ({
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
    window.sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root.unmount());
      root = null;
    }
    container.remove();
    window.sessionStorage.clear();
    global.IntersectionObserver = originalIntersectionObserver;
    jest.restoreAllMocks();
  });

  test("defers cached client data until after the server fallback hydrates", async () => {
    container.innerHTML = renderToString(<Services initialData={null} />);
    window.sessionStorage.setItem(
      "roo-home-data:services",
      JSON.stringify(CACHED_SERVICES)
    );
    window.sessionStorage.setItem("roo-home-data:__ts", String(Date.now()));
    const errorSpy = jest.spyOn(console, "error");

    try {
      await act(async () => {
        root = hydrateRoot(container, <Services initialData={null} />);
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
