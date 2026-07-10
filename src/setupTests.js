import "@testing-library/jest-dom";
import "whatwg-fetch";
import { TextDecoder, TextEncoder } from "node:util";

global.TextEncoder ||= TextEncoder;
global.TextDecoder ||= TextDecoder;

if (typeof Response.json !== "function") {
  Response.json = (body, init = {}) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...(init.headers || {}),
      },
    });
}
