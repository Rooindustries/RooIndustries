import React from "react";
import { render } from "@testing-library/react";
import JsonLd, { serializeJsonLd } from "../next/JsonLd";

describe("JSON-LD serialization", () => {
  test("cannot terminate the script element from CMS content", () => {
    const data = {
      "@context": "https://schema.org",
      name: "</script><script>alert('xss')</script>",
    };
    const serialized = serializeJsonLd(data);
    expect(serialized).not.toContain("</script>");
    expect(serialized).toContain("\\u003c/script\\u003e");

    const { container } = render(<JsonLd data={data} />);
    expect(container.querySelectorAll("script")).toHaveLength(1);
    expect(container.querySelector("script").textContent).not.toContain("<script>");
  });
});
