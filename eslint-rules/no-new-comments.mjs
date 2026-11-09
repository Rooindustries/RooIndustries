import parseSpdx from "spdx-expression-parse";
import { ConfigCommentParser } from "@eslint/plugin-kit";
import ts from "typescript";
import { extract, parseWithComments } from "jest-docblock";

export const normalizeComment = (value) => value.replace(/^\s*\* ?/gm, "").replace(/\s+/g, " ").trim();

export function consumeComment(value, comments) {
  const index = comments.indexOf(normalizeComment(value));
  if (index < 0) return false;
  comments.splice(index, 1);
  return true;
}

export const inRanges = (line, ranges) => ranges.some(([start, count]) => line >= start && line < start + count);
export const whollyChanged = (comment, ranges) =>
  Array.from({ length: comment.loc.end.line - comment.loc.start.line + 1 }, (_, n) => comment.loc.start.line + n)
    .every((line) => inRanges(line, ranges));

const commentParser = new ConfigCommentParser();
const typeFiles = new WeakMap();
function typeDirective(comment, source) {
  if (!typeFiles.has(source)) {
    typeFiles.set(source, ts.createSourceFile("file.tsx", source.text, ts.ScriptTarget.Latest, false));
  }
  const file = typeFiles.get(source);
  const body = comment.value.trim();
  if (/^@ts-(?:expect-error|ignore|check|nocheck)$/.test(body)) {
    return [file.checkJsDirective, ...(file.commentDirectives || []).map(({ range }) => range)]
      .some((range) => range && range.pos >= comment.range[0] && range.end <= comment.range[1]);
  }
  if (comment.type !== "Line" || !/^\/\s*<reference(?:\s+[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'))+\s*\/>$/i.test(body)) {
    return false;
  }
  const entries = [file.pragmas.get("reference")].flat().filter(Boolean);
  const entry = entries.find(({ range }) => range.pos === comment.range[0] && range.end === comment.range[1]);
  const attributes = [...body.matchAll(/\s+([\w-]+)\s*=/g)].map((match) => match[1].toLowerCase());
  return Boolean(entry) && new Set(attributes).size === attributes.length &&
    attributes.every((name) => ts.commentPragmas.reference.args.some((arg) => arg.name === name)) &&
    !file.parseDiagnostics.some(({ start }) => start >= comment.range[0] && start < comment.range[1]);
}
function directlyBefore(comment, source, types) {
  const token = source.getTokenAfter(comment);
  if (!token || source.text.slice(comment.range[1], token.range[0]).trim()) return false;
  for (let node = source.getNodeByRangeIndex(token.range[0]); node; node = node.parent) {
    if (node.range[0] === token.range[0] && types.includes(node.type)) return true;
  }
  return false;
}
function webpackDirective(comment, source) {
  if (comment.type !== "Block") return false;
  let node = source.getNodeByRangeIndex(comment.range[0]);
  while (node && node.type !== "ImportExpression") node = node.parent;
  if (!node || comment.range[1] > node.source.range[0]) return false;
  const file = ts.createSourceFile("options.js", "({" + comment.value + "})", ts.ScriptTarget.Latest, false);
  const expression = file.statements[0]?.expression;
  if (file.parseDiagnostics.length || file.statements.length !== 1 ||
      !expression || !ts.isParenthesizedExpression(expression) ||
      !ts.isObjectLiteralExpression(expression.expression)) {
    return false;
  }
  const literals = new Map();
  const collect = (node) => {
    if (ts.isRegularExpressionLiteral(node)) literals.set(node.getStart(file), node.end);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, file.text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (literals.has(scanner.getTokenPos())) scanner.setTextPos(literals.get(scanner.getTokenPos()));
    else if ([ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia].includes(token)) {
      return false;
    }
  }
  const properties = expression.expression.properties;
  return properties.length > 0 && properties.every((property) => {
    if (!ts.isPropertyAssignment(property) ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return false;
    const key = property.name.text;
    const value = property.initializer;
    const boolean = [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind);
    const number = ts.isNumericLiteral(value) || (ts.isPrefixUnaryExpression(value) &&
      [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(value.operator) &&
      ts.isNumericLiteral(value.operand));
    if (key === "webpackChunkName") return ts.isStringLiteral(value);
    if (key === "webpackMode") return ts.isStringLiteral(value) &&
      ["lazy", "lazy-once", "eager", "weak"].includes(value.text);
    if (key === "webpackFetchPriority") {
      return ts.isStringLiteral(value) && ["high", "low", "auto"].includes(value.text);
    }
    if (["webpackPrefetch", "webpackPreload"].includes(key)) return boolean || number;
    if (key === "webpackIgnore") return boolean;
    if (["webpackInclude", "webpackExclude"].includes(key)) return ts.isRegularExpressionLiteral(value);
    if (key === "webpackExports") return ts.isStringLiteral(value) ||
      (ts.isArrayLiteralExpression(value) && value.elements.every(ts.isStringLiteral));
    return false;
  });
}
function isDirective(comment, source, ruleNames) {
  const body = comment.value.trim();
  if (/^[#@]__PURE__$/.test(body)) return comment.type === "Block" &&
    directlyBefore(comment, source, ["CallExpression", "NewExpression"]);
  if (/^@__NO_SIDE_EFFECTS__$/.test(body)) return comment.type === "Block" &&
    directlyBefore(comment, source, ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
  if (body === "prettier-ignore") return true;
  if (body === "@vite-ignore") return directlyBefore(comment, source, ["Literal", "TemplateLiteral"]) &&
    source.getNodeByRangeIndex(source.getTokenAfter(comment).range[0])?.parent?.type === "ImportExpression";
  if (/^istanbul ignore (?:next|else|if|file)$/.test(body)) return comment.type === "Block";
  if (/^(?:[cv]8) ignore (?:next(?: [0-9]+)?|start|stop)$/.test(body)) return comment.type === "Block";
  if (/@ts-|<reference\s/.test(body) && typeDirective(comment, source)) return true;
  if (/^@jest-environment \S+$/.test(normalizeComment(comment.value)) && comment.type === "Block") {
    const raw = source.text.slice(...comment.range);
    const { pragmas, comments } = parseWithComments(raw);
    return extract(source.text) === raw && !comments &&
      Object.keys(pragmas).length === 1 && typeof pragmas["jest-environment"] === "string";
  }
  if (/webpack[A-Z]/.test(body)) return webpackDirective(comment, source);
  if (!source.getInlineConfigNodes().some(({ range }) =>
    range[0] === comment.range[0] && range[1] === comment.range[1])) return false;
  const directive = commentParser.parseDirective(comment.value);
  if (!directive || /\s-{2,}\s/.test(comment.value)) return false;
  const { label, value } = directive;
  if (/^eslint-(?:disable(?:-(?:next-)?line)?|enable)$/.test(label)) {
    if (label === "eslint-disable-line" && comment.loc.start.line !== comment.loc.end.line) return false;
    return Object.keys(commentParser.parseListConfig(value)).every((name) => ruleNames.includes(name));
  }
  if (label === "eslint") {
    const parsed = commentParser.parseJSONLikeConfig(value);
    return parsed.ok && Object.keys(parsed.config).every((name) => ruleNames.includes(name));
  }
  if (label === "exported") {
    const declared = source.scopeManager.scopes.flatMap((scope) => scope.variables)
      .filter((variable) => variable.identifiers.length).map(({ name }) => name);
    const names = Object.keys(commentParser.parseListConfig(value));
    return names.length > 0 && names.every((name) => declared.includes(name));
  }
  if (label === "global" || label === "globals") {
    const names = Object.entries(commentParser.parseStringConfig(value));
    const parts = value.replace(/\s*:\s*/g, ":").split(/[\s,]+/).filter(Boolean);
    return parts.every((part) => part.split(":").length <= 2) &&
      names.length > 0 && names.every(([name, setting]) => /^[$\p{ID_Start}_][$\p{ID_Continue}\u200c\u200d]*$/u.test(name) &&
      [null, "readonly", "writable", "readable", "writeable", "off", "true", "false"].includes(setting));
  }
  return false;
}
const mit = [
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated',
  'documentation files (the "Software"), to deal in the Software without restriction, including without limitation',
  'the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,',
  'and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
  'The above copyright notice and this permission notice shall be included in all copies or substantial',
  'portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,',
  'INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND',
  'NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR',
  'OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION',
  'WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
].join(" ");
const apache = [
  'Licensed under the Apache License, Version 2.0 (the "License");',
  'you may not use this file except in compliance with the License.',
  'You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0',
  'Unless required by applicable law or agreed to in writing, software',
  'distributed under the License is distributed on an "AS IS" BASIS,',
  'WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.',
  'See the License for the specific language governing permissions and limitations under the License.',
].join(" ");
function license(value, copyrightLines) {
  const lines = value.split("\n").map((line) => line.replace(/^\s*\* ?/, "").trim()).filter(Boolean);
  const prose = [];
  for (const line of lines) {
    if (/^Copyright \(c\) \d{4}(?:-\d{4})? Roo Industries$/.test(line) || copyrightLines.includes(line)) continue;
    if (line.startsWith("SPDX-License-Identifier: ")) {
      try {
        parseSpdx(line.slice("SPDX-License-Identifier: ".length));
      } catch {
        return false;
      }
      continue;
    }
    prose.push(line);
  }
  return lines.length > 0 && (prose.length ?
    [mit, apache].includes(prose.join(" ").replace(/\s+/g, " ")) : lines.length === 1);
}

export default {
  meta: {
    type: "problem",
    schema: [{
      type: "object",
      properties: {
        retainedComments: { type: "array", items: { type: "string" } },
        removedComments: { type: "array", items: { type: "string" } },
        copyrightLines: { type: "array", items: { type: "string" } },
        ruleNames: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    }],
    messages: { added: "Adds a new code comment." },
  },
  create(context) {
    if (!context.options.length) return {};
    const { retainedComments = [], removedComments = [], copyrightLines = [], ruleNames = [] } = context.options[0];
    const retained = [...retainedComments];
    const removed = [...removedComments];
    return {
      Program() {
        const comments = context.sourceCode.getAllComments();
        const licenses = new Set();
        for (let i = 0; i < comments.length; i++) {
          const group = [comments[i]];
          while (comments[i].type === "Line" && comments[i + 1]?.type === "Line" &&
              comments[i + 1].loc.start.line === comments[i].loc.end.line + 1 &&
              !context.sourceCode.text.slice(comments[i].range[1], comments[i + 1].range[0]).trim()) {
            group.push(comments[++i]);
          }
          if (license(group.map((comment) => comment.value).join("\n"), copyrightLines)) {
            for (const comment of group) licenses.add(comment);
          }
        }
        for (const comment of comments) {
          if (comment.type === "Shebang" || consumeComment(comment.value, retained) ||
              consumeComment(comment.value, removed) || isDirective(comment, context.sourceCode, ruleNames) ||
              license(comment.value, copyrightLines) || licenses.has(comment)) continue;
          context.report({ loc: comment.loc, messageId: "added" });
        }
      },
    };
  },
};
