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
  REDUCED_MOTION_CLASS,
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
    expect(snapshot.reason).toBe("default-lite-mode");
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
      source: "auto",
      reason: "default-lite-mode",
      deviceClass: DEVICE_CLASSES.DESKTOP,
    });
    expect(isLowPerformanceModeEnabled()).toBe(true);
    expect(isReducedEffectsModeEnabled()).toBe(true);
    expect(getPerformanceProfileSnapshot().profile).toBe(
      PERFORMANCE_PROFILES.LITE
    );
  });

  it("does not dispatch a change event for silent initialization", () => {
    const handler = jest.fn();
    window.addEventListener(PERFORMANCE_PROFILE_EVENT, handler);

    initializePerformanceProfile();

    expect(handler).toHaveBeenCalledTimes(0);

    window.removeEventListener(PERFORMANCE_PROFILE_EVENT, handler);
  });

  it("keeps useLowPerformanceMode consumers on the lite path", () => {
    initializePerformanceProfile();

    function Probe() {
      const lowPerformanceMode = useLowPerformanceMode();
      return <div>{lowPerformanceMode ? "lite" : "not-lite"}</div>;
    }

    render(<Probe />);
    expect(screen.getByText("lite")).toBeInTheDocument();
  });

  it("keeps usePerformanceProfile consumers on the lite snapshot", () => {
    initializePerformanceProfile();

    function Probe() {
      const perf = usePerformanceProfile();
      return <div>{perf.profile}</div>;
    }

    render(<Probe />);

    expect(screen.getByText(PERFORMANCE_PROFILES.LITE)).toBeInTheDocument();
  });

  it("allows the test override to exercise full-mode semantics", () => {
    act(() => {
      __applyPerformanceDecisionForTests({
        reason: "test-override",
        profile: PERFORMANCE_PROFILES.FULL,
      });
    });

    expect(getPerformanceProfileSnapshot()).toMatchObject({
      profile: PERFORMANCE_PROFILES.FULL,
      reason: "test-override",
    });
    expect(
      document.documentElement.classList.contains(LOW_PERFORMANCE_CLASS)
    ).toBe(false);
  });

  it("renders no performance notice UI", () => {
    render(<PerformanceModeNotice />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("updates reduced-motion preferences without changing the lite profile", () => {
    let reducedMotion = false;
    let onChange;
    setWindowValue("matchMedia", jest.fn(() => ({
      matches: reducedMotion,
      addEventListener: (_event, listener) => { onChange = listener; },
      removeEventListener: jest.fn(),
    })));
    initializePerformanceProfile();
    const handler = jest.fn();
    window.addEventListener(PERFORMANCE_PROFILE_EVENT, handler);

    reducedMotion = true;
    onChange();

    expect(getPerformanceProfileSnapshot()).toMatchObject({
      profile: PERFORMANCE_PROFILES.LITE,
      prefersReducedMotion: true,
    });
    expect(document.documentElement).toHaveClass(REDUCED_MOTION_CLASS);
    expect(handler).toHaveBeenCalledTimes(1);

    reducedMotion = false;
    onChange();
    expect(handler).toHaveBeenCalledTimes(2);

    expect(getPerformanceProfileSnapshot().prefersReducedMotion).toBe(false);
    expect(document.documentElement).not.toHaveClass(REDUCED_MOTION_CLASS);
    expect(document.documentElement).toHaveClass(LOW_PERFORMANCE_CLASS);
    window.removeEventListener(PERFORMANCE_PROFILE_EVENT, handler);
  });
});
