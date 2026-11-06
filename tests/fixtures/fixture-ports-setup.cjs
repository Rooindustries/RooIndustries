const { loadFixturePorts } = require("./fixture-ports.cjs");

module.exports = async () => {
  await loadFixturePorts(process.env.BASE_URL);
};
