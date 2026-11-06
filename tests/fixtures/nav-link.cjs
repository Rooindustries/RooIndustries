const navLink = (target) => {
  const surface = target === "plans" ? "bar" : "desktop";
  return `[data-nav-surface="${surface}"][data-nav-target="${target}"]`;
};

module.exports = { navLink };
