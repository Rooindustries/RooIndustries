import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

if (process.argv[1]?.endsWith('/scripts/test-tooling-sweep-server.mjs') && process.env.NEXT_DIST_DIR) {
  const logFile = `${process.env.NEXT_DIST_DIR}-server.log`;
  fs.writeFileSync(logFile, '');
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options = {}) => {
    const stdio = options.stdio;
    if (!Array.isArray(stdio) || stdio[2] !== 'inherit') return spawn(command, args, options);
    const child = spawn(command, args, { ...options, stdio: [stdio[0], stdio[1], 'pipe', ...stdio.slice(3)] });
    child.stderr.on('data', chunk => {
      process.stderr.write(chunk);
      fs.appendFileSync(logFile, chunk);
    });
    return child;
  };
  syncBuiltinESMExports();
}
