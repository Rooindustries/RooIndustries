const barLink = (target) =>
  `:is([data-nav-surface="desktop"], [data-nav-surface="bar"])[data-nav-target="${target}"]`;

module.exports = { barLink };
