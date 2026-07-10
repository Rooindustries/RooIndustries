/** @jest-environment node */

import { NextRequest } from "next/server";
import { middleware } from "../../middleware";

describe("URL privacy middleware", () => {
  test("redirects browser pages after removing sensitive query values", () => {
    const request = new NextRequest(
      "https://www.rooindustries.com/payment?data=private&paymentAccessToken=secret&ref=servi"
    );
    const response = middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://www.rooindustries.com/payment?ref=servi"
    );
  });

  test("does not strip temporary compatibility tokens from API routes", () => {
    const request = new NextRequest(
      "https://www.rooindustries.com/api/downloads/file?token=temporary"
    );
    const response = middleware(request);

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });
});
