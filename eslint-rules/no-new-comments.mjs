import { ConfigCommentParser } from "@eslint/plugin-kit";

export const normalizeComment = (value) => value.replace(/^\s*\* ?/gm, "").replace(/\s+/g, " ").trim();

export function consumeComment(value, comments) {
  const index = comments.indexOf(normalizeComment(value));
  if (index < 0) return false;
  comments.splice(index, 1);
  return true;
}

export function commentGroups(source, ranges) {
  const groups = [];
  for (const comment of source.getAllComments()) {
    const previous = groups.at(-1);
    if (previous?.type === "Line" && comment.type === "Line" &&
        whollyChanged(previous, ranges) && whollyChanged(comment, ranges) &&
        !isDirective(previous.value) && !isDirective(comment.value) &&
        comment.loc.start.line === previous.loc.end.line + 1 &&
        !source.text.slice(previous.range[1], comment.range[0]).trim()) {
      previous.value += `\n${comment.value}`;
      previous.loc = { start: previous.loc.start, end: comment.loc.end };
      previous.range = [previous.range[0], comment.range[1]];
    } else {
      groups.push({ ...comment });
    }
  }
  return groups;
}

export const inRanges = (line, ranges) => ranges.some(([start, count]) => line >= start && line < start + count);
export const whollyChanged = (comment, ranges) =>
  Array.from({ length: comment.loc.end.line - comment.loc.start.line + 1 }, (_, n) => comment.loc.start.line + n)
    .every((line) => inRanges(line, ranges));

const ruleNames = "[\\w@./-]+";
const directives = [
  new RegExp(`^eslint-(?:disable|enable)(?:-next-line|-line)?(?:\\s+${ruleNames}(?:\\s*,\\s*${ruleNames})*)?$`),
  /^exported\s+[\w$]+(?:\s*,\s*[\w$]+)*$/,
  /^(?:prettier-ignore|@vite-ignore|@ts-expect-error|@ts-ignore|@ts-check|@ts-nocheck|[#@]__PURE__|@__NO_SIDE_EFFECTS__)$/,
  /^(?:istanbul|[cv]8) ignore (?:next|else|if|file|start|stop)$/,
];
const commentParser = new ConfigCommentParser();
function isDirective(value) {
  const text = value.trim();
  if (directives.some((pattern) => pattern.test(text))) return true;
  const directive = text.match(/^globals?\s+([\s\S]+)$/);
  if (!directive) return false;
  const entries = Object.entries(commentParser.parseStringConfig(directive[1]));
  return entries.length > 0 && entries.every(([name, setting]) => /^[\w$]+$/.test(name) &&
    [null, "readonly", "writable", "readable", "writeable", "off", "true", "false"].includes(setting));
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
function license(value) {
  const lines = value.split("\n").map((line) => normalizeComment(line)).filter(Boolean);
  const prose = lines.filter((line) =>
    !/^SPDX-License-Identifier: \(*[\w.+-]+\)*(?: (?:AND|OR|WITH) \(*[\w.+-]+\)*)*$/.test(line) &&
    !/^(?:Copyright (?:\(c\) |© )?|© )\d{4}\b[^\n]*$/i.test(line)).join(" ");
  return lines.length > 0 && (!prose || prose === mit || prose === apache ||
    /^Licensed under the (?:MIT|Apache(?: License)?(?:,? Version)? 2\.0|BSD(?:-[23]-Clause)?) license\.$/i.test(prose));
}

export default {
  meta: {
    type: "problem",
    schema: [{
      type: "object",
      properties: {
        addedRanges: { type: "array" },
        retainedComments: { type: "array", items: { type: "string" } },
        removedComments: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    }],
    messages: { added: "Adds a new code comment." },
  },
  create(context) {
    if (!context.options.length) return {};
    const { addedRanges = [], retainedComments = [], removedComments = [] } = context.options[0];
    const retained = [...retainedComments];
    const removed = [...removedComments];
    return {
      Program() {
        for (const comment of commentGroups(context.sourceCode, addedRanges)) {
          if (comment.type === "Shebang" || consumeComment(comment.value, retained) ||
              consumeComment(comment.value, removed) || isDirective(comment.value) ||
              (!context.sourceCode.getTokenBefore(comment) && license(comment.value))) continue;
          context.report({ loc: comment.loc, messageId: "added" });
        }
      },
    };
  },
};
