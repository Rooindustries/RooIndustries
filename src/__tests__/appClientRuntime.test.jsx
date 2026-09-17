import { render } from "@testing-library/react";
import { Analytics } from "@vercel/analytics/react";
import AppClientRuntime from "../next/AppClientRuntime";

jest.mock("@vercel/analytics/react", () => ({ Analytics: jest.fn(() => null) }));

import {
  loadSeorceScript,
  shouldLoadSeorce,
} from "../next/AppClientRuntime";

const scriptId = "seorce-runtime-script";

describe("Seorce runtime loading", () => {
  beforeEach(() => {
    document.getElementById(scriptId)?.remove();
  });

  test("allows only production hosts and non-sensitive routes", () => {
    expect(shouldLoadSeorce("/", "www.rooindustries.com")).toBe(true);
    expect(shouldLoadSeorce("/packages", "rooindustries.com")).toBe(true);
    expect(shouldLoadSeorce("/", "quiet-code-checks.vercel.app")).toBe(false);
    expect(shouldLoadSeorce("/", "localhost")).toBe(false);
    expect(shouldLoadSeorce("/payment", "www.rooindustries.com")).toBe(false);
    expect(shouldLoadSeorce("/booking/confirm", "www.rooindustries.com")).toBe(
      false
    );
  });

  test("stays quiet on preview hosts and loads on production", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    for (let attempt = 0; attempt < 9; attempt += 1) {
      expect(
        loadSeorceScript({
          pathname: "/",
          hostname: "quiet-code-checks.vercel.app",
        })
      ).toBe(false);
    }

    expect(document.getElementById(scriptId)).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    expect(
      loadSeorceScript({
        pathname: "/",
        hostname: "www.rooindustries.com",
      })
    ).toBe(true);

    const script = document.getElementById(scriptId);
    expect(script).not.toBeNull();
    expect(script.src).toBe(
      "https://scripts.seorce.com/api?projectId=6a2e76bf3f9dac8c30e27b89"
    );

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

test("the shared runtime tracks public routes without a sales router", () => {
  render(<AppClientRuntime />);
  const { beforeSend } = Analytics.mock.calls.at(-1)[0];
  expect(beforeSend({ type: "pageview", url: "https://www.rooindustries.com/tourney?email=private@example.invalid#token" })).toEqual({ type: "pageview", url: "https://www.rooindustries.com/tourney" });
  expect(beforeSend({ type: "pageview", url: "https://www.rooindustries.com/referrals/reset?token=secret" })).toBeNull();
});
