const { loadFixturePorts } = require("./fixture-ports.cjs");

module.exports = () => {
  loadFixturePorts(process.env.BASE_URL);
};
