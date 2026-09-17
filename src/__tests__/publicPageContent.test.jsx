import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import Packages from "../legacyPages/Packages";
import Contact from "../legacyPages/Contact";

jest.mock("../components/Footer", () => () => null);
jest.mock("../components/PackageDetailsModal", () => () => null);

test("renders supplied package content before client effects run", () => {
  const html = renderToString(
    <MemoryRouter initialEntries={["/packages"]}>
      <Packages initialData={{ packagesList: [{ _id: "package-test", title: "Independent Package", price: "$42.50", description: "A measured tuning session.", checkedBullets: ["Measured results"] }], packagesSettings: { title: "Choose your session" } }} />
    </MemoryRouter>
  );
  expect(html).toContain("Independent Package");
  expect(html).toContain("$42.50");
  expect(html).toContain("Measured results");
});

test("renders authoritative contact content before client effects run", () => {
  const html = renderToString(<Contact initialData={{ title: "Talk to our team", email: "support@example.invalid" }} />);
  expect(html).toContain("Talk to our team");
  expect(html).toContain("support@example.invalid");
});
