const { evaluateBrowserTask } = require("./browser-task.cjs");
const { waitForRouteCommitted } = require("./react-hydration.cjs");

const sampleScrollAfterClick = async (page, button) => {
  await waitForRouteCommitted(page);
  await page.waitForFunction(
    ({ scope, text }) => [...document.querySelectorAll(`${scope} button`)].some(
      (element) => element.textContent.trim().startsWith(text) && !element.disabled &&
        Object.keys(element).some((key) => key.startsWith("__reactProps$"))
    ),
    button,
    { timeout: 15000 }
  );
  return evaluateBrowserTask(page, ({ scope, text, from }) => new Promise((resolve) => {
    const find = () => [...document.querySelectorAll(`${scope} button`)]
      .find((element) => element.textContent.trim().startsWith(text));
    const questionPage = () => document.querySelector("#faq .ri-faq-question")?.parentElement;
    window.scrollTo({ top: from === "top" ? 0 : document.documentElement.scrollHeight, behavior: "instant" });
    let lastY = -1;
    let stillFrames = 0;
    const settle = () => {
      stillFrames = window.scrollY === lastY ? stillFrames + 1 : 0;
      lastY = window.scrollY;
      if (stillFrames < 10) {
        requestAnimationFrame(settle);
        return;
      }
      const frames = [window.scrollY];
      const previousPage = questionPage();
      let frame;
      let lastLayout;
      let stableFrames = 0;
      const sample = () => frames.push(window.scrollY);
      const finish = () => {
        cancelAnimationFrame(frame);
        sample();
        document.removeEventListener("scroll", sample);
        document.removeEventListener("scrollend", finish);
        resolve({
          frames,
          offset: scope === "#faq" ? document.querySelector("#faq").getBoundingClientRect().top - 96 : window.scrollY,
        });
      };
      const checkNoScroll = () => {
        if (frames.some((y) => Math.abs(y - frames[0]) > 1)) return;
        const nextPage = questionPage();
        const style = nextPage && getComputedStyle(nextPage);
        const rect = nextPage?.getBoundingClientRect();
        const layout = JSON.stringify([rect?.height, style?.transform, style?.opacity, style?.filter]);
        const ready = scope !== "#faq" || (nextPage !== previousPage && style?.opacity === "1" &&
          new DOMMatrixReadOnly(style.transform).isIdentity);
        stableFrames = ready && layout === lastLayout ? stableFrames + 1 : 0;
        lastLayout = layout;
        if (stableFrames >= 10) finish();
        else frame = requestAnimationFrame(checkNoScroll);
      };
      document.addEventListener("scroll", sample);
      document.addEventListener("scrollend", finish);
      find().click();
      frame = requestAnimationFrame(checkNoScroll);
    };
    requestAnimationFrame(settle);
  }), button);
};

const scrollPath = ({ frames, offset }) => {
  const start = frames[0];
  const end = frames[frames.length - 1];
  return {
    distance: Math.abs(end - start),
    inBetween: frames.filter((y) => Math.abs(y - start) > 1 && Math.abs(y - end) > 1),
    offset,
  };
};

module.exports = { sampleScrollAfterClick, scrollPath };
