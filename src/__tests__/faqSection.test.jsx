import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import FaqSection from "../components/Faq";

let mockLocation = {
  pathname: "/",
  search: "",
  hash: "",
  state: null,
};

const mockAlignToHashTarget = jest.fn();

jest.mock(
  "react-router-dom",
  () => ({
    __esModule: true,
    useLocation: () => mockLocation,
  }),
  { virtual: true }
);

jest.mock("framer-motion", () => {
  const React = require("react");

  const createMotionComponent = (tag) =>
    React.forwardRef(
      (
        {
          animate,
          custom,
          exit,
          initial,
          layout,
          transition,
          variants,
          whileHover,
          whileTap,
          children,
          ...props
        },
        ref
      ) => React.createElement(tag, { ...props, ref }, children)
    );

  return {
    AnimatePresence: ({ children }) => <>{children}</>,
    motion: new Proxy(
      {},
      {
        get: (_target, key) => createMotionComponent(key),
      }
    ),
  };
});

jest.mock(
  "lucide-react",
  () => ({
    ChevronDown: (props) => <svg {...props} />,
  }),
  { virtual: true }
);

jest.mock("../lib/homeSectionData", () => ({
  fetchHomeSectionData: jest.fn().mockResolvedValue([]),
  HOME_SECTION_DATA_KEYS: {
    faqSettings: "faqSettings",
    faqQuestions: "faqQuestions",
  },
  readHomeSectionData: jest.fn(() => null),
}));

jest.mock("../lib/scrollCoordinator", () => ({
  alignToHashTarget: (...args) => mockAlignToHashTarget(...args),
  getCssHeaderOffsetPx: jest.fn(() => 96),
}));

describe("FaqSection", () => {
  beforeEach(() => {
    mockLocation = {
      pathname: "/",
      search: "",
      hash: "",
      state: null,
    };
    mockAlignToHashTarget.mockReset();
    window.history.replaceState({}, "", "/");
    window.scrollTo = jest.fn();
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  afterEach(() => {
    cleanup();
  });

  test("opens the upgrade faq when section intent is dispatched on the home page", async () => {
    render(
      <FaqSection
        initialFaqCopy={{}}
        initialQuestions={[
          {
            question:
              'What does "Upgrade PC each 6 months and get reXOC\'d for free" mean?',
            answer: "Buy once and never again!",
          },
        ]}
      />
    );

    expect(screen.queryByText(/buy once and never again/i)).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("roo:pending-section-target", {
          detail: { hash: "#upgrade-path" },
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/buy once and never again/i)).toBeInTheDocument();
    });

    expect(mockAlignToHashTarget).toHaveBeenCalledWith(
      expect.objectContaining({ hash: "#upgrade-path" })
    );
  });
});
