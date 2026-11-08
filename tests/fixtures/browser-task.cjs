const { readFileSync } = require("node:fs");
const { join } = require("node:path");

let nextTask = 0;

const pageScript = (name) => readFileSync(join(__dirname, "browser", name), "utf8").trim();

async function evaluateBrowserTask(target, action, arg) {
  const page = typeof target.page === "function" ? target.page() : target;
  const key = `browser-task-${++nextTask}`;
  const start = new Function("first", "second", `
    const element = first instanceof Node;
    const job = element ? second : first;
    const tasks = window.__browserTasks ||= {};
    const task = tasks[job.key] = { done: false };
    const reject = (error) => {
      task.error = { name: error?.name || "Error", message: String(error?.message || error), stack: error?.stack };
      task.done = true;
    };
    try {
      task.promise = Promise.resolve((${action.toString()})(...(element ? [first, job.arg] : [job.arg])));
      task.promise.then(value => {
        task.value = value;
        task.done = true;
      }, reject);
    } catch (error) {
      reject(error);
    }
  `);
  try {
    await target.evaluate(start, { key, arg });
    await page.waitForFunction((key) => {
      const task = window.__browserTasks?.[key];
      if (!task) throw new Error("Browser task lost its document");
      return task.done;
    }, key);
    const result = await page.evaluate((key) => {
      const { value, error } = window.__browserTasks[key];
      return { value, error };
    }, key);
    if (result.error) {
      const error = new Error(result.error.message);
      error.name = result.error.name;
      if (result.error.stack) error.stack = result.error.stack;
      throw error;
    }
    return result.value;
  } finally {
    await page.evaluate((key) => { delete window.__browserTasks?.[key]; }, key);
  }
}

module.exports = { evaluateBrowserTask, pageScript };
