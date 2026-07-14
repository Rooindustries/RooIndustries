/** @jest-environment node */

const {
  readBoundedFormData,
  readBoundedJson,
} = require("../server/request/boundedJson");

const request = (body, contentType = "application/json") => ({
  headers: {
    get: (name) => {
      if (String(name).toLowerCase() === "content-type") return contentType;
      if (String(name).toLowerCase() === "content-length") {
        return String(Buffer.byteLength(body));
      }
      return "";
    },
  },
  text: async () => body,
});

describe("bounded JSON parser", () => {
  test("accepts a small object", async () => {
    await expect(readBoundedJson(request('{"flow":"tourney"}'))).resolves.toEqual({
      flow: "tourney",
    });
  });

  test("rejects duplicate properties", async () => {
    await expect(
      readBoundedJson(request('{"provider":"google","provider":"discord"}'))
    ).rejects.toMatchObject({ status: 400 });
  });

  test("rejects unsupported content types", async () => {
    await expect(
      readBoundedJson(request('{"ok":true}', "text/plain"))
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      readBoundedJson(request('{"ok":true}', "application/jsonp"))
    ).rejects.toMatchObject({ status: 415 });
  });

  test("rejects oversized and deeply nested bodies", async () => {
    await expect(
      readBoundedJson(request(JSON.stringify({ value: "x".repeat(200) })), {
        maxBytes: 64,
      })
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      readBoundedJson(request('{"a":{"b":{"c":true}}}'), { maxDepth: 2 })
    ).rejects.toMatchObject({ status: 413 });
  });

  test("stops a streamed body as soon as it crosses the byte limit", async () => {
    const streamed = new Request("https://example.test/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(200) }),
    });
    await expect(readBoundedJson(streamed, { maxBytes: 64 }))
      .rejects.toMatchObject({ status: 413 });
  });
});

describe("bounded form parser", () => {
  test("accepts a small URL-encoded form", async () => {
    const form = await readBoundedFormData(request(
      "login=player%40example.com",
      "application/x-www-form-urlencoded"
    ));
    expect(Object.fromEntries(form.entries())).toEqual({
      login: "player@example.com",
    });
  });

  test("accepts a streamed multipart form without changing its boundary", async () => {
    const boundary = "RooBoundaryABC123";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="action"',
      "",
      "apply",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const form = await readBoundedFormData(request(
      body,
      `multipart/form-data; boundary=${boundary}`
    ));
    expect(form.get("action")).toBe("apply");
  });

  test("rejects duplicate and oversized form fields", async () => {
    await expect(readBoundedFormData(request(
      "login=first&login=second",
      "application/x-www-form-urlencoded"
    ))).rejects.toMatchObject({ status: 400 });
    await expect(readBoundedFormData(request(
      `login=${"x".repeat(100)}`,
      "application/x-www-form-urlencoded"
    ), { maxBytes: 32 })).rejects.toMatchObject({ status: 413 });
    await expect(readBoundedFormData(request(
      "login=player",
      "application/x-www-form-urlencodedevil"
    ))).rejects.toMatchObject({ status: 415 });
  });
});
