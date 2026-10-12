const path = require("node:path");
const { firefox } = require("playwright");
const launch = firefox.launch.bind(firefox);

firefox.launch = options => launch({
  ...options,
  executablePath: path.join(__dirname, "unavailable-firefox"),
});
