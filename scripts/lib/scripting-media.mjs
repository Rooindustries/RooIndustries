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

const importLayer = /^\s*layer(?:\(\s*[^()]*\))?/i;
const importSupports = /^\s*supports\(/i;

const afterParens = (text, open) => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")" && --depth === 0) return text.slice(index + 1);
  }
  return "";
};

const importMedia = (params) => {
  let rest = params.replace(ignoredTokens, " ").replace(importLayer, "");
  const supports = rest.match(importSupports);
  if (supports) rest = afterParens(rest, supports.index + supports[0].length - 1);
  return rest;
};

const mediaText = {
  media: (params) => params,
  "custom-media": (params) => params,
  import: importMedia,
};

export const scriptingAtRules = (css, from) => {
  const found = [];
  postcss.parse(css, { from }).walkAtRules((rule) => {
    const media = mediaText[rule.name.toLowerCase()];
    if (media && usesScriptingMedia(media(rule.params))) found.push(rule);
  });
  return found;
};

export const scriptingMessage =
  "Safari before 17 ignores the scripting media feature, so styles behind it never apply there. " +
  "Make the no-JavaScript styles the default and put JavaScript-only styles under html.js.";
