const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const nativeBinaries = [process.env.PG_BIN && path.join(process.env.PG_BIN, 'postgres'), process.env.POSTGREST_BIN];
const nativeBinariesMissing = !nativeBinaries.every(file => file && fs.existsSync(file));

const nativeFixture = module => [async ({}, use) => {
  const child = fork(module, [], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const pending = new Map();
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => {
      if (message.ready) return resolve();
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
    });
    child.on('exit', code => {
      const error = new Error(`Native fixture exited (${code})`);
      reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    });
  });
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.send({ id, method, args });
  });
  try {
    await ready;
    await use(call);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      await call('stop');
      await exited;
    }
  }
}, { scope: 'worker' }];

module.exports = { nativeFixture, nativeBinariesMissing };
