const http = require("node:http");
const { test, expect } = require("@playwright/test");

test("the app keeps an idle connection open past the default timeout", async ({ baseURL }) => {
  const defaults = http.createServer();
  const idle = defaults.keepAliveTimeout + (defaults.keepAliveTimeoutBuffer ?? 0) + 1000;
  test.setTimeout(idle + 30000);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const get = () => new Promise((resolve, reject) => {
    http.get(new URL("/robots.txt", baseURL), { agent }, (response) => {
      const { socket, statusCode } = response;
      response.resume();
      response.on("error", reject);
      response.on("end", () => resolve({ socket, statusCode }));
    }).on("error", reject);
  });
  try {
    const first = await get();
    expect(first.statusCode).toBe(200);
    let closed = false;
    first.socket.once("close", () => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, idle));
    expect(closed).toBe(false);
    const second = await get();
    expect(second.statusCode).toBe(200);
    expect(second.socket).toBe(first.socket);
  } finally {
    agent.destroy();
  }
});
