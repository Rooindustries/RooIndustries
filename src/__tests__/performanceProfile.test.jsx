import React from "react";
import { act, render, screen } from "@testing-library/react";
import PerformanceModeNotice from "../components/PerformanceModeNotice";
import {
  __applyPerformanceDecisionForTests,
  __resetPerformanceProfileForTests,
  bootstrapPerformanceProfile,
  buildDeviceSignature,
  DEVICE_CLASSES,
  evaluateRuntimeMetrics,
  LOW_PERFORMANCE_CLASS,
  LEGACY_LITE_MODE_KEY,
  LEGACY_LITE_MODE_MANUAL_KEY,
  PERFORMANCE_NOTICE_DISMISS_KEY,
  PERFORMANCE_PROFILE_EVENT,
  PERFORMANCE_PROFILE_STORAGE_KEY,
  PERFORMANCE_PROFILES,
  readLegacyManualDecision,
  readStoredAutoDecision,
  REDUCED_EFFECTS_CLASS,
  resolveDeviceClass,
  resolveInitialPerformanceDecision,
  useLowPerformanceMode,
} from "../lib/performanceProfile";
import { PERF_DEBUG_STORAGE_KEY } from "../lib/perfDebug";

const defaultMatchMedia = (query) => ({
  matches: false,
  media: query,
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
  addListener: jest.fn(),
  removeListener: jest.fn(),
});

const setNavigatorValue = (key, value) => {
  Object.defineProperty(window.navigator, key, {
    configurable: true,
    value,
  });
};

const setWindowValue = (key, value) => {
  Object.defineProperty(window, key, {
    configurable: true,
    value,
  });
};

const createSnapshot = (overrides = {}) => ({
  deviceClass: DEVICE_CLASSES.MOBILE,
  hardwareConcurrency: 6,
  deviceMemory: 4,
  dpr: 2,
  saveData: false,
  rendererInfo: {
    checked: false,
    hasWebgl: null,
    likelySoftware: false,
    renderer: "",
    family: "unknown",
  },
  ...overrides,
});

const createDecision = (overrides = {}) => ({
  profile: PERFORMANCE_PROFILES.FULL,
  source: "default",
  reason: "test",
  deviceClass: DEVICE_CLASSES.MOBILE,
  band: "mid",
  renderer: "",
  expiresAt: null,
  ...overrides,
});

describe("performanceProfile", () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    __resetPerformanceProfileForTests();
    localStorage.clear();
    setWindowValue("matchMedia", jest.fn(defaultMatchMedia));
    setWindowValue("devicePixelRatio", 2);
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    setNavigatorValue(
      "userAgent",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/123.0 Mobile Safari/537.36"
    );
    setNavigatorValue("platform", "Linux armv8l");
    setNavigatorValue("maxTouchPoints", 5);
    setNavigatorValue("hardwareConcurrency", 6);
    setNavigatorValue("deviceMemory", 4);
    setNavigatorValue("connection", { saveData: false });
    setNavigatorValue("userAgentData", { mobile: true });
  });

  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it("classifies desktop hardware renderers as full mode", () => {
    const decision = resolveInitialPerformanceDecision(
      createSnapshot({
        deviceClass: DEVICE_CLASSES.DESKTOP,
        rendererInfo: {
          checked: true,
          hasWebgl: true,
          likelySoftware: false,
          renderer: "ANGLE (NVIDIA GeForce RTX 4080)",
          family: "unknown",
        },
      })
    );

    expect(decision.profile).toBe(PERFORMANCE_PROFILES.FULL);
    expect(decision.deviceClass).toBe(DEVICE_CLASSES.DESKTOP);
  });

  it("classifies desktop software renderers as lite mode", () => {
    const decision = resolveInitialPerformanceDecision(
      createSnapshot({
        deviceClass: DEVICE_CLASSES.DESKTOP,
        rendererInfo: {
          checked: true,
          hasWebgl: true,
          likelySoftware: true,
          renderer: "Google SwiftShader",
          family: "unknown",
        },
      })
    );

    expect(decision.profile).toBe(PERFORMANCE_PROFILES.LITE);
    expect(decision.reason).toBe("desktop-software-renderer");
  });

  it("treats iPadOS-on-Mac as a tablet", () => {
    const deviceClass = resolveDeviceClass({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.2 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
      userAgentDataMobile: false,
    });

    expect(deviceClass).toBe(DEVICE_CLASSES.TABLET);
  });

  it("classifies low-end Android signals into reduced mode", () => {
    const decision = resolveInitialPerformanceDecision(
      createSnapshot({
        hardwareConcurrency: 4,
        deviceMemory: 3,
        dpr: 3,
      })
    );

    expect(decision.profile).toBe(PERFORMANCE_PROFILES.REDUCED);
    expect(decision.reason).toBe("mobile-low-end-heuristic");
  });

  it("keeps mid-tier Android in full mode", () => {
    const decision = resolveInitialPerformanceDecision(
      createSnapshot({
        hardwareConcurrency: 6,
        deviceMemory: 4,
        dpr: 3,
      })
    );

    expect(decision.profile).toBe(PERFORMANCE_PROFILES.FULL);
    expect(decision.band).toBe("mid");
  });

  it("marks high-end Apple mobile hardware as full mode", () => {
    const decision = resolveInitialPerformanceDecision(
      createSnapshot({
        deviceClass: DEVICE_CLASSES.TABLET,
        hardwareConcurrency: 8,
        deviceMemory: null,
        rendererInfo: {
          checked: true,
          hasWebgl: true,
          likelySoftware: false,
          renderer: "Apple GPU",
          family: "high",
        },
      })
    );

    expect(decision.profile).toBe(PERFORMANCE_PROFILES.FULL);
    expect(decision.band).toBe("high");
  });

  it("keeps conservative flagship Android bootstrap signals out of lite mode", () => {
    const decision = resolveInitialPerformanceDecision(
      createSnapshot({
        hardwareConcurrency: 4,
        deviceMemory: 4,
        dpr: 3.5,
      })
    );

    expect(decision.profile).toBe(PERFORMANCE_PROFILES.REDUCED);
    expect(decision.band).toBe("low");
  });

  it("treats Adreno TM 830 renderer strings as high-tier mobile GPUs", () => {
    const decision = resolveInitialPerformanceDecision(
      createSnapshot({
        hardwareConcurrency: 4,
        deviceMemory: 4,
        dpr: 3.5,
        rendererInfo: {
          checked: true,
          hasWebgl: true,
          likelySoftware: false,
          renderer: "ANGLE (Qualcomm, Adreno (TM) 830, OpenGL ES 3.2)",
          family: "high",
        },
      })
    );

    expect(decision.profile).toBe(PERFORMANCE_PROFILES.FULL);
    expect(decision.band).toBe("mid");
  });

  it("applies a stored auto decision during bootstrap", () => {
    const snapshot = createSnapshot();
    localStorage.setItem(
      PERFORMANCE_PROFILE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        profile: PERFORMANCE_PROFILES.LITE,
        source: "auto",
        reason: "mobile-software-renderer",
        deviceSignature: buildDeviceSignature(snapshot),
        expiresAt: Date.now() + 60_000,
      })
    );

    bootstrapPerformanceProfile();

    expect(document.documentElement.classList.contains(LOW_PERFORMANCE_CLASS)).toBe(
      true
    );
  });

  it("ignores stale legacy manual lite overrides outside perf debug", () => {
    const snapshot = createSnapshot();
    localStorage.setItem(LEGACY_LITE_MODE_KEY, "on");
    localStorage.setItem(LEGACY_LITE_MODE_MANUAL_KEY, "1");

    const decision = readLegacyManualDecision({ snapshot });

    expect(decision).toBeNull();
    expect(localStorage.getItem(LEGACY_LITE_MODE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_LITE_MODE_MANUAL_KEY)).toBeNull();
  });

  it("keeps legacy manual lite overrides available in perf debug", () => {
    const snapshot = createSnapshot();
    localStorage.setItem(PERF_DEBUG_STORAGE_KEY, "1");
    localStorage.setItem(LEGACY_LITE_MODE_KEY, "on");
    localStorage.setItem(LEGACY_LITE_MODE_MANUAL_KEY, "1");

    const decision = readLegacyManualDecision({ snapshot });

    expect(decision?.profile).toBe(PERFORMANCE_PROFILES.LITE);
    expect(decision?.reason).toBe("legacy-lite-manual-on");
  });

  it("switches desktop GPU-off sessions into lite mode during bootstrap", () => {
    setNavigatorValue(
      "userAgent",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/123.0 Safari/537.36"
    );
    setNavigatorValue("platform", "MacIntel");
    setNavigatorValue("maxTouchPoints", 0);
    setNavigatorValue("userAgentData", { mobile: false });
    HTMLCanvasElement.prototype.getContext = jest.fn(() => null);

    bootstrapPerformanceProfile();

    expect(document.documentElement.classList.contains(LOW_PERFORMANCE_CLASS)).toBe(
      true
    );
  });

  it("ignores expired stored decisions", () => {
    const snapshot = createSnapshot();
    localStorage.setItem(
      PERFORMANCE_PROFILE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        profile: PERFORMANCE_PROFILES.LITE,
        source: "auto",
        reason: "runtime-degraded",
        deviceSignature: buildDeviceSignature(snapshot),
        expiresAt: Date.now() - 1,
      })
    );

    const decision = readStoredAutoDecision({ snapshot });

    expect(decision).toBeNull();
    expect(localStorage.getItem(PERFORMANCE_PROFILE_STORAGE_KEY)).toBeNull();
  });

  it("ignores stored decisions when the device signature changes", () => {
    const snapshot = createSnapshot();
    localStorage.setItem(
      PERFORMANCE_PROFILE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        profile: PERFORMANCE_PROFILES.LITE,
        source: "auto",
        reason: "runtime-degraded",
        deviceSignature: buildDeviceSignature(
          createSnapshot({ hardwareConcurrency: 8 })
        ),
        expiresAt: Date.now() + 60_000,
      })
    );

    const decision = readStoredAutoDecision({ snapshot });

    expect(decision).toBeNull();
  });

  it("ignores stored runtime-lite decisions for high-end mobile devices", () => {
    const snapshot = createSnapshot({
      hardwareConcurrency: 8,
      deviceMemory: 8,
      rendererInfo: {
        checked: false,
        hasWebgl: null,
        likelySoftware: false,
        renderer: "",
        family: "unknown",
      },
    });

    localStorage.setItem(
      PERFORMANCE_PROFILE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        profile: PERFORMANCE_PROFILES.LITE,
        source: "auto",
        reason: "runtime-severe-degradation",
        deviceSignature: buildDeviceSignature(snapshot),
        expiresAt: Date.now() + 60_000,
      })
    );

    const decision = readStoredAutoDecision({ snapshot });

    expect(decision).toBeNull();
    expect(localStorage.getItem(PERFORMANCE_PROFILE_STORAGE_KEY)).toBeNull();
  });

  it("ignores stored runtime-lite decisions for mid-band mobile devices", () => {
    const snapshot = createSnapshot({
      hardwareConcurrency: 8,
      deviceMemory: 4,
      dpr: 3.5,
    });

    localStorage.setItem(
      PERFORMANCE_PROFILE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        profile: PERFORMANCE_PROFILES.LITE,
        source: "auto",
        reason: "runtime-persistently-degraded",
        deviceSignature: buildDeviceSignature(snapshot),
        expiresAt: Date.now() + 60_000,
      })
    );

    const decision = readStoredAutoDecision({ snapshot });

    expect(decision).toBeNull();
    expect(localStorage.getItem(PERFORMANCE_PROFILE_STORAGE_KEY)).toBeNull();
  });

  it("keeps healthy runtime metrics in full mode", () => {
    const decision = evaluateRuntimeMetrics({
      decision: createDecision(),
      metrics: {
        frames: 180,
        longFrameRatio: 5,
        severeFrames: 1,
        longTaskTotalMs: 100,
      },
    });

    expect(decision).toBeNull();
  });

  it("downgrades bad first-window runtime metrics to reduced", () => {
    const decision = evaluateRuntimeMetrics({
      decision: createDecision(),
      metrics: {
        frames: 180,
        longFrameRatio: 20,
        severeFrames: 7,
        longTaskTotalMs: 260,
      },
      stage: 0,
    });

    expect(decision?.profile).toBe(PERFORMANCE_PROFILES.REDUCED);
    expect(decision?.reason).toBe("runtime-degraded");
  });

  it("downgrades sustained second-window failures to lite", () => {
    const decision = evaluateRuntimeMetrics({
      decision: createDecision({
        profile: PERFORMANCE_PROFILES.REDUCED,
      }),
      metrics: {
        frames: 180,
        longFrameRatio: 24,
        severeFrames: 11,
        longTaskTotalMs: 420,
      },
      stage: 1,
    });

    expect(decision?.profile).toBe(PERFORMANCE_PROFILES.LITE);
    expect(decision?.reason).toBe("runtime-persistently-degraded");
  });

  it("caps high-end mobile first-pass failures at reduced instead of lite", () => {
    const decision = evaluateRuntimeMetrics({
      decision: createDecision({
        band: "high",
      }),
      metrics: {
        frames: 180,
        longFrameRatio: 42,
        severeFrames: 20,
        longTaskTotalMs: 900,
      },
      stage: 0,
    });

    expect(decision?.profile).toBe(PERFORMANCE_PROFILES.REDUCED);
    expect(decision?.reason).toBe("runtime-degraded");
  });

  it("never auto-downgrades desktop GPU-on decisions from runtime metrics", () => {
    const decision = evaluateRuntimeMetrics({
      decision: createDecision({
        deviceClass: DEVICE_CLASSES.DESKTOP,
        band: "unknown",
      }),
      metrics: {
        frames: 180,
        longFrameRatio: 45,
        severeFrames: 30,
        longTaskTotalMs: 1200,
      },
      stage: 0,
    });

    expect(decision).toBeNull();
  });

  it("dispatches performance change payloads with detail", () => {
    const handler = jest.fn();
    window.addEventListener(PERFORMANCE_PROFILE_EVENT, handler);

    act(() => {
      __applyPerformanceDecisionForTests(
        createDecision({
          profile: PERFORMANCE_PROFILES.LITE,
          reason: "desktop-software-renderer",
          deviceClass: DEVICE_CLASSES.DESKTOP,
          band: "unknown",
        })
      );
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail).toMatchObject({
      profile: PERFORMANCE_PROFILES.LITE,
      reason: "desktop-software-renderer",
      deviceClass: DEVICE_CLASSES.DESKTOP,
    });

    window.removeEventListener(PERFORMANCE_PROFILE_EVENT, handler);
  });

  it("keeps useLowPerformanceMode consumers working in lite mode", () => {
    function Probe() {
      const lowPerformanceMode = useLowPerformanceMode();
      return <div>{lowPerformanceMode ? "lite" : "full"}</div>;
    }

    render(<Probe />);
    expect(screen.getByText("full")).toBeInTheDocument();

    act(() => {
      __applyPerformanceDecisionForTests(
        createDecision({
          profile: PERFORMANCE_PROFILES.LITE,
          band: "low",
        })
      );
    });

    expect(screen.getByText("lite")).toBeInTheDocument();
  });

  it("renders desktop GPU warning copy", () => {
    render(<PerformanceModeNotice />);

    act(() => {
      __applyPerformanceDecisionForTests(
        createDecision({
          profile: PERFORMANCE_PROFILES.LITE,
          reason: "desktop-software-renderer",
          deviceClass: DEVICE_CLASSES.DESKTOP,
          band: "unknown",
        })
      );
    });

    expect(
      screen.getByText(
        "Hardware acceleration appears disabled. Lite Mode has been enabled for smoother scrolling."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Chrome: Settings > System > Use graphics acceleration when available."
      )
    ).toBeInTheDocument();
  });

  it("renders reduced-effects copy without desktop GPU guidance", () => {
    render(<PerformanceModeNotice />);

    act(() => {
      __applyPerformanceDecisionForTests(
        createDecision({
          profile: PERFORMANCE_PROFILES.REDUCED,
          reason: "runtime-degraded",
          deviceClass: DEVICE_CLASSES.MOBILE,
          band: "mid",
        })
      );
    });

    expect(
      screen.getByText(
        "Reduced effects have been enabled for smoother scrolling on this device."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Use graphics acceleration when available/)
    ).not.toBeInTheDocument();
    expect(
      document.documentElement.classList.contains(REDUCED_EFFECTS_CLASS)
    ).toBe(true);
    expect(localStorage.getItem(PERFORMANCE_NOTICE_DISMISS_KEY)).toBeNull();
  });
});
