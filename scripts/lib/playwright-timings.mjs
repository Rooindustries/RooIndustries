const fileSeconds = (report) => {
  if (
    report && typeof report === "object" && !Array.isArray(report) &&
    !("suites" in report) && Object.values(report).every((value) => typeof value === "number")
  ) return report;
  const seconds = {};
  const walk = (suite, file) => {
    const owner = suite.file || file;
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        for (const result of test.results || []) {
          seconds[owner] = (seconds[owner] || 0) + result.duration / 1000;
        }
      }
    }
    for (const child of suite.suites || []) walk(child, owner);
  };
  for (const suite of report.suites || []) walk(suite, suite.file);
  return seconds;
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const mergeTimings = (reports) => {
  const samples = {};
  for (const report of reports) {
    for (const [file, seconds] of Object.entries(fileSeconds(report))) {
      (samples[file] ||= []).push(seconds);
    }
  }
  return Object.fromEntries(
    Object.keys(samples)
      .sort()
      .map((file) => [file, Math.round(median(samples[file]) * 10) / 10]),
  );
};
