const waitFrames = (page, count) => page.evaluate(total => new Promise(resolve => {
  let left = total;
  const step = () => {
    left -= 1;
    if (left <= 0) resolve();
    else requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}), count);

const settle = async page => {
  await page.waitForLoadState("networkidle");
  await waitFrames(page, 2);
};

module.exports = { settle, waitFrames };
