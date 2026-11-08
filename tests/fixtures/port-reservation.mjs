import http from "node:http";
import { freeTcpPort, releaseTcpPorts } from "../../scripts/lib/free-tcp-port.mjs";

const [mode, host, requested] = process.argv.slice(2);
if (mode === "reserve") {
  try {
    const port = await freeTcpPort(host, Number(requested));
    console.log(JSON.stringify({ port }));
    await releaseTcpPorts(host, [port]);
  } catch (error) {
    console.log(JSON.stringify({ code: error.code }));
  }
} else if (mode === "bind-later") {
  console.log("waiting");
  process.stdin.once("data", () => {
    http.createServer((request, response) => response.end("owner")).listen(Number(requested), host);
  });
} else {
  throw new Error("Unknown reservation fixture mode.");
}
