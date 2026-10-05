const childProcess = require('node:child_process');
globalThis.rooEarlyChildMethods = {
  execSync: childProcess.execSync,
  execFileSync: childProcess.execFileSync,
};
if (process.argv.includes('--early-cjs-capture')) delete process.env.NODE_OPTIONS;
