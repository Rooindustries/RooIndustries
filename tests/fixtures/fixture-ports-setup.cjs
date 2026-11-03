const { loadFixturePorts } = require("./fixture-ports.cjs");

module.exports = config => {
  const ports = loadFixturePorts(config.metadata.toolingDistDir, process.env.BASE_URL);
  if (config.metadata.ownsToolingServer && !ports) throw new Error("The fixture server did not report its ports.");
};
