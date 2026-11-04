const aliases = { "-r": "--require", "--loader": "--experimental-loader" };
const canonical = (flag) => aliases[flag] ?? flag;

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

const hasNodeOption = (tokens, flag, value) => tokens.some((token, index) => {
  const separator = token.indexOf("=");
  if (separator > 0 && canonical(token.slice(0, separator)) === flag) return token.slice(separator + 1) === value;
  return canonical(token) === flag && tokens[index + 1] === value;
});

export const appendNodeOption = (nodeOptions, flag, value) => {
  const current = String(nodeOptions ?? "");
  const option = canonical(flag);
  if (hasNodeOption(parseNodeOptions(current), option, String(value))) return current;
  return `${current}${current ? " " : ""}${option}=${quoteNodeOption(value)}`;
};

export const withNodeOption = (env, flag, ...values) => ({
  ...env,
  NODE_OPTIONS: values.reduce((nodeOptions, value) => appendNodeOption(nodeOptions, flag, value), env?.NODE_OPTIONS),
});
