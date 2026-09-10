import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import Services from "../components/Services";

jest.mock("../sanityClient", () => ({ urlFor: jest.fn() }));

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
  expect(page.querySelector("details").hasAttribute("open")).toBe(false);
  expect(page.querySelector("details")).toHaveTextContent("RTX 4080");
});

it.each([null, undefined, "", " ", "not a number", Infinity, -1, 0, true, []])(
  "does not invent an improvement for missing or invalid before FPS: %p",
  (beforeFps) => {
    render(wrap({ benchPages: [{ games: [game({ beforeFps })] }] }));
    const result = screen.getByRole("article");
    expect(result).toHaveTextContent("—");
    expect(result).not.toHaveTextContent("%");
    expect(result).not.toHaveTextContent(/NaN|Infinity/);
  },
);

it("shows a negative result without a misleading plus sign", () => {
  render(wrap({ benchPages: [{ games: [game({ afterFps: 100 })] }] }));
  expect(screen.getByRole("article")).toHaveTextContent("-50%");
  expect(screen.getByRole("article")).not.toHaveTextContent("+-50%");
});

it("skips empty pages and keeps page controls within the available results", () => {
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
  expect(screen.getByRole("heading", { name: "VALORANT" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Next benchmark page" }),
  ).toBeDisabled();
  rerender(wrap({ benchPages: [{ games: [game()] }] }));
  expect(
    screen.getByRole("heading", { name: "Overwatch 2" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Next benchmark page" }),
  ).not.toBeInTheDocument();
});

it("respects the benchmark visibility setting", () => {
  render(wrap({ benchEnabled: false, benchPages: [{ games: [game()] }] }));
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Compare packages" }),
  ).toHaveAttribute("href", "/#packages");
});
