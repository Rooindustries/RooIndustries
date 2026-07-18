import React from "react";
import { cleanup, render } from "@testing-library/react";
import IntercomMessenger from "../components/IntercomMessenger";

const mockLocation = { pathname: "/" };

jest.mock("react-router-dom", () => ({
  useLocation: () => mockLocation,
}));

const disabledRoutes = ["/booking", "/payment"];

describe("IntercomMessenger checkout visibility", () => {
  beforeEach(() => {
    mockLocation.pathname = "/";
    document.getElementById("intercom-embed-script")?.remove();
    delete window.Intercom;
    delete window.__rooIntercomBooted;
    delete window.intercomSettings;
  });

  afterEach(() => {
    cleanup();
  });

  test.each(["/booking", "/booking/details", "/payment", "/payment/retry"])(
    "does not load Intercom on %s",
    (pathname) => {
      mockLocation.pathname = pathname;

      render(<IntercomMessenger disabledRoutes={disabledRoutes} />);

      expect(document.getElementById("intercom-embed-script")).toBeNull();
      expect(window.Intercom).toBeUndefined();
    }
  );

  test("loads Intercom on the homepage", () => {
    render(<IntercomMessenger disabledRoutes={disabledRoutes} />);

    expect(document.getElementById("intercom-embed-script")).not.toBeNull();
    expect(window.intercomSettings).toEqual(
      expect.objectContaining({ hide_default_launcher: false })
    );
  });

  test("hides and restores Intercom with the checkout overlay signal", () => {
    const { rerender } = render(
      <IntercomMessenger disabledRoutes={disabledRoutes} disabled={false} />
    );

    expect(document.getElementById("intercom-embed-script")).not.toBeNull();

    rerender(<IntercomMessenger disabledRoutes={disabledRoutes} disabled />);

    expect(window.intercomSettings).toEqual(
      expect.objectContaining({ hide_default_launcher: true })
    );
    expect(window.Intercom.q.map((args) => args[0])).toContain("hide");

    rerender(
      <IntercomMessenger disabledRoutes={disabledRoutes} disabled={false} />
    );

    expect(document.getElementById("intercom-embed-script")).not.toBeNull();
    expect(window.intercomSettings).toEqual(
      expect.objectContaining({ hide_default_launcher: false })
    );
  });
});
