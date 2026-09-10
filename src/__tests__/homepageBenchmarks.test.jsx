import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import Services from "../components/Services";

jest.mock("../sanityClient", () => ({ urlFor: jest.fn() }));

const originalIntersectionObserver = global.IntersectionObserver;

beforeAll(() => {
  global.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterAll(() => {
  global.IntersectionObserver = originalIntersectionObserver;
});

const about = {
  recordDetails: [{ label: "RANK", value: "#31" }],
  recordLink: "https://www.3dmark.com/hall-of-fame",
};
const wrap = (data) => (
  <MemoryRouter>
    <Services initialData={data} initialAboutData={about} />
  </MemoryRouter>
);
const game = (overrides = {}) => ({
  gameTitle: "Overwatch 2",
  beforeFps: 200,
  afterFps: 450,
  gpu: "RTX 4080",
  cpu: "7900X3D",
  ram: "32GB 6000MT/s CL30",
  ...overrides,
});

it("includes real benchmark values and benefits in server-rendered HTML", () => {
  const html = renderToString(wrap({ benchPages: [{ games: [game()] }] }));
  const page = document.createElement("div");
  page.innerHTML = html;
  expect(
    within(page).getByRole("heading", {
      name: "Built For Ranked Games",
      level: 2,
    }),
  ).toBeTruthy();
  expect(within(page).getByRole("article")).toHaveTextContent("200");
  expect(within(page).getByRole("article")).toHaveTextContent("450");
  expect(within(page).getByRole("article")).toHaveTextContent("+125%");
  expect(page.querySelector(".ri-service-card").style.opacity).not.toBe("0");
  const hardware = page.querySelector(".ri-bench-hardware");
  expect(hardware.closest("details")).toBeNull();
  expect(hardware).toHaveTextContent("RTX 4080");
  expect(hardware).toHaveTextContent("7900X3D");
  expect(hardware).toHaveTextContent("32GB 6000MT/s CL30");
});

it.each([null, undefined, "", " ", "not a number", Infinity, -1, 0, true, []])(
  "does not invent an improvement for missing or invalid before FPS: %p",
  (beforeFps) => {
    render(wrap({ benchPages: [{ games: [game({ beforeFps })] }] }));
    const result = screen.getByRole("article");
    expect(result.querySelector(".ri-bench-number")).toHaveTextContent("-");
    expect(result).not.toHaveTextContent("%");
    expect(result).not.toHaveTextContent(/NaN|Infinity/);
  },
);

it("shows a negative result without a misleading plus sign", () => {
  render(wrap({ benchPages: [{ games: [game({ afterFps: 100 })] }] }));
  expect(screen.getByRole("article")).toHaveTextContent("-50%");
  expect(screen.getByRole("article")).not.toHaveTextContent("+-50%");
});

it("skips empty pages and keeps page controls within the available results", async () => {
  const { rerender } = render(
    wrap({
      benchPages: [
        null,
        { games: [null] },
        { games: [game()] },
        { games: [game({ gameTitle: "VALORANT" })] },
      ],
    }),
  );
  expect(
    screen.getByRole("button", { name: "Previous benchmark page" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Next benchmark page" }));
  await waitFor(() =>
    expect(screen.getByText("VALORANT", { exact: true })).toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: "Next benchmark page" }),
  ).toBeDisabled();
  rerender(wrap({ benchPages: [{ games: [game()] }] }));
  await waitFor(() =>
    expect(
      screen.getByText("Overwatch 2", { exact: true }),
    ).toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: "Next benchmark page" }),
  ).toBeDisabled();
});

it("respects the benchmark visibility setting", () => {
  render(wrap({ benchEnabled: false, benchPages: [{ games: [game()] }] }));
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
});
