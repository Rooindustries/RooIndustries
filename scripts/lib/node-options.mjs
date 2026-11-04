import fs from "node:fs";
import { fileURLToPath } from "node:url";

const moduleFlags = { "--import": "--import", "--require": "--require", "-r": "--require" };

const moduleFlag = (flag) => {
  const option = moduleFlags[flag];
  if (!option) throw new TypeError(`NODE_OPTIONS helpers only add module-loading flags (--import, --require, -r), not ${JSON.stringify(flag)}.`);
  return option;
};

const parseNodeOptions = (value) => {
  const tokens = [];
  let token = "", quoted = false;
  const source = String(value ?? "");
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "\\" && quoted && index + 1 < source.length) token += source[++index];
    else if (character === '"') quoted = !quoted;
    else if (character === " " && !quoted) { if (token) tokens.push(token); token = ""; }
    else token += character;
  }
  if (token) tokens.push(token);
  return tokens;
};

const quoteNodeOption = (value) => `"${String(value).replace(/[\\"]/g, "\\$&")}"`;

const loadsModule = (tokens, flag, value) => tokens.some((token, index) => {
  const separator = token.indexOf("=");
  if (separator > 0) return moduleFlags[token.slice(0, separator)] === flag && token.slice(separator + 1) === value;
  return moduleFlags[token] === flag && tokens[index + 1] === value;
});

export const appendNodeOption = (nodeOptions, flag, value) => {
  const current = String(nodeOptions ?? "");
  const option = moduleFlag(flag);
  if (loadsModule(parseNodeOptions(current), option, String(value))) return current;
  return `${current}${current ? " " : ""}${option}=${quoteNodeOption(value)}`;
};

export const withNodeOption = (env, flag, ...values) => ({
  ...env,
  NODE_OPTIONS: values.reduce((nodeOptions, value) => appendNodeOption(nodeOptions, flag, value), env?.NODE_OPTIONS),
});

const runsAsCli = () => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (runsAsCli()) {
  const args = process.argv.slice(2);
  try {
    if (!args.length || args.length % 2) throw new TypeError("Usage: node scripts/lib/node-options.mjs --import <path> [--require <path> ...]");
    let nodeOptions = process.env.NODE_OPTIONS ?? "";
    for (let index = 0; index < args.length; index += 2) nodeOptions = appendNodeOption(nodeOptions, args[index], args[index + 1]);
    process.stdout.write(nodeOptions);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
