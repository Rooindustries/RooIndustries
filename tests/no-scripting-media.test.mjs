import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import tailwindConfig from "../tailwind.config.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "no-scripting-media-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const check = (targets = [], env = {}) => {
  const result = spawnSync(process.execPath, ["scripts/check-no-scripting-media.mjs", ...targets], {
    encoding: "utf8",
    env: { ...process.env, NEXT_DIST_DIR: "", ...env },
  });
  const hits = result.stderr.split("\n").filter((line) => /^\S+:\d+ @/.test(line));
  return { status: result.status, hits, output: result.stdout + result.stderr };
};

const write = (name, css) => {
  const file = path.join(tmp, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, css);
  return file;
};

const build = async (css, config) =>
  (await postcss([tailwindcss(config), autoprefixer()]).process(css, { from: path.resolve("src/index.css") })).css;

describe("check-no-scripting-media", () => {
  it("fails on the scripting rules src/index.css had on main", () => {
    const { status, hits } = check(["tests/fixtures/scripting-media-main.css"]);
    assert.equal(status, 1);
    assert.deepEqual(hits, [
      "tests/fixtures/scripting-media-main.css:6 @media (scripting: none)",
      "tests/fixtures/scripting-media-main.css:23 @media (scripting: none)",
    ]);
  });

  it("fails on Tailwind output from a raw screen and an arbitrary variant", async () => {
    const css = await build("@tailwind utilities;", {
      content: [{ raw: '<div class="hidden no-js:block [@media(_scripting:_none)]:flex">' }],
      theme: { extend: { screens: { "no-js": { raw: "(scripting: none)" } } } },
    });
    const { status, hits } = check([write("tailwind.css", css)]);
    assert.equal(status, 1);
    assert.equal(hits.length, 2, css);
  });

  it("fails on escaped, negated and imported forms", () => {
    const file = write(
      "forms.css",
      [
        "@media (scripting) {}",
        "@media not (scripting) {}",
        "@media (scripting:initial-only) {}",
        "@media (\\73 cripting: none) {}",
        "@media (SCR\\IPTING : enabled) {}",
        "@media screen and (/* x */ scripting /* y */) {}",
        "@import url(no-js.css) (scripting: none);",
        '@import "no-js.css" screen, (scripting: none);',
        "@custom-media --no-js (scripting: none);",
        "@supports (display: grid) { @media (scripting: none) {} }",
        "@container card (min-width: 1px) { @media (scripting: none) {} }",
        "@layer base { @media (scripting: none) {} }",
        "@import url(a.css) layer(base) supports(display: grid) (scripting: none);",
        "@MEDIA (scripting) {}",
        '@import url("a.css") supports(display: grid) (scripting: none);',
      ].join("\n"),
    );
    const { status, hits } = check([file]);
    assert.equal(status, 1);
    assert.deepEqual(
      hits.map((hit) => Number(hit.split(":")[1].split(" ")[0])),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    );
  });

  it("ignores comments, content strings, selectors and import URLs", () => {
    const file = write(
      "harmless.css",
      [
        "/* @media (scripting: none) used to hide this */",
        '.a::before { content: "(scripting)"; }',
        ".\\[\\@media\\(_scripting\\:_none\\)\\]\\:x { color: red; }",
        '@import url("(scripting:none).css") screen;',
        "@import url((scripting).css);",
        "@keyframes scripting { to { opacity: 1; } }",
        "@media (prefers-reduced-motion: reduce) { .a { animation: none; } }",
        "@scope (.\\(scripting\\)) { .a { color: red; } }",
        "@container style(--label: (scripting)) { .a { color: red; } }",
        "@container (scripting) { .a { color: red; } }",
        "@supports selector(.\\(scripting\\)) { .a { color: red; } }",
        "@layer scripting { .a { color: red; } }",
        '@import "a.css" supports((scripting: none)) screen;',
        '@import url("editor.css") supports(selector(:state(scripting))) screen;',
      ].join("\n"),
    );
    const { status, output } = check([file]);
    assert.equal(status, 0, output);
  });

  it("passes on the built src/index.css and public stylesheets", async () => {
    const css = await build(fs.readFileSync("src/index.css", "utf8"), tailwindConfig);
    assert.match(css, /html\.js \.deferred-section-content/);
    const dist = path.join(tmp, "dist");
    write("dist/static/css/app.css", css);
    write("dist/cache/stale.css", "@media (scripting: none) {}");
    const { status, output } = check([], { NEXT_DIST_DIR: dist });
    assert.equal(status, 0, output);
    assert.match(output, /No scripting media feature in \d+ CSS files\./);
  });

  it("fails when the build has no CSS", () => {
    const { status, output } = check([], { NEXT_DIST_DIR: path.join(tmp, "missing") });
    assert.equal(status, 1);
    assert.match(output, /Run the Next build first/);
  });
});
