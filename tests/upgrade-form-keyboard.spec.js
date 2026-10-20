const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata", viewport: { width: 390, height: 844 } });

for (const route of ["/upgrade/max", "/upgrade-xoc"]) {
  test.describe(route, () => {
    test("Enter in the Order ID field checks eligibility", async ({ page, flow }) => {
      await flow.upgrade(route);
      await page.getByRole("textbox", { name: "Enter your Order ID", exact: true }).press("Enter");
      await expect(page.getByRole("heading", { name: "Upgrade Summary", exact: true })).toBeVisible();
      expect(flow.state.calls.filter(({ path }) => path === "/api/ref/getUpgradeInfo")).toHaveLength(1);
    });

    test("a missing Order ID is announced and the label sits on its own field", async ({ page, flow }) => {
      await flow.upgrade(route);
      const email = page.getByRole("textbox", { name: "Booking email", exact: true });
      const order = page.getByRole("textbox", { name: "Enter your Order ID", exact: true });
      await order.fill("");
      await email.press("Enter");
      await expect(page.getByRole("alert").filter({ hasText: "Please enter the Order ID from your confirmation email." })).toBeVisible();
      await expect(order).toHaveAccessibleDescription(/booking email \(labelled "Order ID"\)/);
      await expect(order).toHaveAttribute("aria-invalid", "true");
      await expect(order).toHaveAccessibleDescription(/Please enter the Order ID from your confirmation email\./);
      await expect(email).not.toHaveAttribute("aria-invalid", "true");
      const [emailBox, labelBox, orderBox] = await Promise.all([
        email.boundingBox(),
        page.getByText("Enter your Order ID", { exact: true }).boundingBox(),
        order.boundingBox(),
      ]);
      expect(labelBox.y).toBeGreaterThan(emailBox.y + emailBox.height);
      expect(labelBox.y).toBeLessThan(orderBox.y);
    });

    test("a missing booking email marks the email field", async ({ page, flow }) => {
      await flow.upgrade(route);
      const email = page.getByRole("textbox", { name: "Booking email", exact: true });
      const order = page.getByRole("textbox", { name: "Enter your Order ID", exact: true });
      await email.fill("");
      await order.press("Enter");
      await expect(page.getByRole("alert").filter({ hasText: "Please enter the email used on the original booking." })).toBeVisible();
      await expect(email).toHaveAttribute("aria-invalid", "true");
      await expect(email).toHaveAccessibleDescription("Please enter the email used on the original booking.");
      await expect(order).not.toHaveAttribute("aria-invalid", "true");
      await email.fill("visitor@example.invalid");
      await expect(email).not.toHaveAttribute("aria-invalid", "true");
    });
  });
}
