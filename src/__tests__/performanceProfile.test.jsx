import React from "react";
import { act, render, screen } from "@testing-library/react";
import PerformanceModeNotice from "../components/PerformanceModeNotice";
import {
  __applyPerformanceDecisionForTests,
  __resetPerformanceProfileForTests,
  bootstrapPerformanceProfile,
  DEVICE_CLASSES,
  LOW_PERFORMANCE_CLASS,
  PERFORMANCE_PROFILE_EVENT,
  PERFORMANCE_PROFILES,
  REDUCED_EFFECTS_CLASS,
  getPerformanceProfileSnapshot,
  initializePerformanceProfile,
  isLowPerformanceModeEnabled,
  isReducedEffectsModeEnabled,
  useLowPerformanceMode,
  usePerformanceProfile,
} from "../lib/performanceProfile";

const defaultMatchMedia = (query) => ({
  matches: query === "(prefers-reduced-motion: reduce)",
  media: query,
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
  addListener: jest.fn(),
  removeListener: jest.fn(),
});

const setWindowValue = (key, value) => {
  Object.defineProperty(window, key, {
    configurable: true,
    value,
  });
};

describe("performanceProfile", () => {
  beforeEach(() => {
    __resetPerformanceProfileForTests();
    setWindowValue("matchMedia", jest.fn(defaultMatchMedia));
  });

  it("bootstraps the site into lite mode", () => {
    const snapshot = bootstrapPerformanceProfile();

    expect(snapshot.profile).toBe(PERFORMANCE_PROFILES.LITE);
    expect(snapshot.reason).toBe("site-lite-only");
    expect(document.documentElement.classList.contains(LOW_PERFORMANCE_CLASS)).toBe(
      true
    );
    expect(
      document.documentElement.classList.contains(REDUCED_EFFECTS_CLASS)
    ).toBe(false);
  });

  it("initializes a stable lite snapshot", () => {
    const snapshot = initializePerformanceProfile();

    expect(snapshot).toMatchObject({
      profile: PERFORMANCE_PROFILES.LITE,
      source: "forced",
      reason: "site-lite-only",
      deviceClass: DEVICE_CLASSES.DESKTOP,
    });
    expect(isLowPerformanceModeEnabled()).toBe(true);
    expect(isReducedEffectsModeEnabled()).toBe(false);
    expect(getPerformanceProfileSnapshot().profile).toBe(
      PERFORMANCE_PROFILES.LITE
    );
  });

  it("dispatches one compatibility event when initialized", () => {
    const handler = jest.fn();
    window.addEventListener(PERFORMANCE_PROFILE_EVENT, handler);

    initializePerformanceProfile();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail).toMatchObject({
      profile: PERFORMANCE_PROFILES.LITE,
      reason: "site-lite-only",
    });

    window.removeEventListener(PERFORMANCE_PROFILE_EVENT, handler);
  });

  it("keeps useLowPerformanceMode consumers on the lite path", () => {
    function Probe() {
      const lowPerformanceMode = useLowPerformanceMode();
      return <div>{lowPerformanceMode ? "lite" : "not-lite"}</div>;
    }

    render(<Probe />);
    expect(screen.getByText("lite")).toBeInTheDocument();
  });

  it("keeps usePerformanceProfile consumers on the lite snapshot", () => {
    function Probe() {
      const perf = usePerformanceProfile();
      return <div>{perf.profile}</div>;
    }

    render(<Probe />);

    expect(screen.getByText(PERFORMANCE_PROFILES.LITE)).toBeInTheDocument();
  });

  it("keeps the test override on lite semantics", () => {
    act(() => {
      __applyPerformanceDecisionForTests({
        reason: "test-override",
        profile: PERFORMANCE_PROFILES.FULL,
      });
    });

    expect(getPerformanceProfileSnapshot()).toMatchObject({
      profile: PERFORMANCE_PROFILES.LITE,
      reason: "test-override",
    });
    expect(document.documentElement.classList.contains(LOW_PERFORMANCE_CLASS)).toBe(
      true
    );
  });

  it("renders no performance notice UI", () => {
    render(<PerformanceModeNotice />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
