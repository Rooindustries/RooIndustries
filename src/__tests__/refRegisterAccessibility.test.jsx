import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import RefRegister from "../components/RefRegister";

jest.mock("../components/SupabaseSocialLogin", () => () => null);

describe("referral registration accessibility", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ authenticated: false }),
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("announces validation errors immediately", () => {
    render(
      <MemoryRouter>
        <RefRegister />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole("button", { name: "Register" }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert).toHaveTextContent("Please fill in all fields.");
  });
});
