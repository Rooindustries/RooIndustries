import { act, render, screen } from "@testing-library/react";

const mockUsePathname = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

jest.mock("next/dynamic", () => {
  const React = require("react");
  let callCount = 0;

  return {
    __esModule: true,
    default: jest.fn(() => {
      const testId = callCount === 0 ? "analytics" : "speed-insights";
      callCount += 1;
      return function MockDynamicComponent() {
        return React.createElement("div", { "data-testid": testId });
      };
    }),
  };
});

const TourneyTelemetry = require("../../app/tourney/TourneyTelemetry").default;

describe("TourneyTelemetry", () => {
  let idleCallback;

  beforeEach(() => {
    idleCallback = undefined;
    mockUsePathname.mockReturnValue("/tourney/bracket");
    window.requestIdleCallback = jest.fn((callback) => {
      idleCallback = callback;
      return 1;
    });
    window.cancelIdleCallback = jest.fn();
  });

  afterEach(() => {
    delete window.requestIdleCallback;
    delete window.cancelIdleCallback;
  });

  test("loads click analytics immediately and defers speed insights", () => {
    render(<TourneyTelemetry />);

    expect(screen.getByTestId("analytics")).toBeInTheDocument();
    expect(screen.queryByTestId("speed-insights")).not.toBeInTheDocument();

    act(() => idleCallback());

    expect(screen.getByTestId("speed-insights")).toBeInTheDocument();
  });

  test("keeps telemetry off private tournament routes", () => {
    mockUsePathname.mockReturnValue("/tourney/payouts");

    render(<TourneyTelemetry />);

    expect(screen.queryByTestId("analytics")).not.toBeInTheDocument();
    expect(screen.queryByTestId("speed-insights")).not.toBeInTheDocument();
    expect(window.requestIdleCallback).not.toHaveBeenCalled();
  });
});
