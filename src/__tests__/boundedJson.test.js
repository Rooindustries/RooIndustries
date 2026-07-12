const { readBoundedJson } = require("../server/request/boundedJson");

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
});
