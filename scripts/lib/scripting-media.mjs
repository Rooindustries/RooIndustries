import postcss from "postcss";

const ignoredTokens = /\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|url\(\s*[^)"'\s]*\s*\)/gi;
const cssEscape = /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S]))/g;
const scriptingFeature = /\(\s*scripting\s*[:)]/i;

const codePoint = (hex) => {
  const value = Number.parseInt(hex, 16);
  const invalid = value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff);
  return invalid ? "�" : String.fromCodePoint(value);
};

const unescapeCss = (text) =>
  text.replace(cssEscape, (_, hex, newline, char) => (hex ? codePoint(hex) : newline ? "" : char));

export const usesScriptingMedia = (mediaText) =>
  scriptingFeature.test(unescapeCss(mediaText.replace(ignoredTokens, " ")));

export const scriptingAtRules = (css, from) => {
  const found = [];
  postcss.parse(css, { from }).walkAtRules((rule) => {
    if (usesScriptingMedia(rule.params)) found.push(rule);
  });
  return found;
};

export const scriptingMessage =
  "Safari before 17 ignores the scripting media feature, so styles behind it never apply there. " +
  "Make the no-JavaScript styles the default and put JavaScript-only styles under html.js.";
