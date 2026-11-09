const { ReadableStream } = require("node:stream/web");

const providerResponse = (body, status = 200) => ({
  status,
  headers: { "content-type": "application/json" },
  body: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
      controller.close();
    },
  }),
});

module.exports = providerResponse;
