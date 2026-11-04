export const cpuMsOf = async work => {
  const before = process.cpuUsage();
  await work();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
};

const summary = (cpuMs, limit, stoppedEarly) => {
  const longCpuMs = Math.min(...cpuMs.long);
  const shortCpuMs = Math.min(...cpuMs.short);
  return {
    longCpuMs,
    shortCpuMs,
    ratio: longCpuMs / shortCpuMs,
    slow: longCpuMs >= limit * shortCpuMs,
    measurements: cpuMs.long.length + cpuMs.short.length,
    stoppedEarly,
  };
};

export const compareSides = async ({ rounds, limit, measure }) => {
  const cpuMs = { long: [], short: [] };
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 ? ["short", "long"] : ["long", "short"];
    for (const side of order) {
      cpuMs[side].push(await measure(side, round));
      await new Promise(resolve => setImmediate(resolve));
      const clearlySlow = cpuMs.long.length >= 2 && Math.min(...cpuMs.long) > limit * Math.min(...cpuMs.short);
      if (clearlySlow) {
        return summary(cpuMs, limit, true);
      }
    }
  }
  return summary(cpuMs, limit, false);
};

export const compareUntilSlow = async (comparisons, { rounds, limit }) => {
  const results = [];
  for (const { details, measure } of comparisons) {
    const result = { ...details, ...(await compareSides({ rounds, limit, measure })) };
    results.push(result);
    if (result.slow) {
      break;
    }
  }
  return results;
};
