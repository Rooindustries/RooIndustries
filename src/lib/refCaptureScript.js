const fs = require("node:fs");
const path = require("node:path");
const REF_CAPTURE_SCRIPT = fs.readFileSync(path.join(process.cwd(), "public", "ref-capture.js"), "utf8");
module.exports = { REF_CAPTURE_SCRIPT };
module.exports.default = module.exports;
