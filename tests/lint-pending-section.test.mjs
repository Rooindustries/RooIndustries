import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { RuleTester } from "eslint";
import { rules } from "../eslint-rules/index.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester().run("no-pending-section-storage-bypass", rules["no-pending-section-storage-bypass"], {
  valid: [
    "readPendingSectionTarget(); clearPendingSectionTarget();",
    'sessionStorage.setItem("theme", "dark");',
    {
      filename: fileURLToPath(new URL("../src/lib/sectionNavigation.js", import.meta.url)),
      code: 'const PENDING_SECTION_KEY = "roo_pending_section"; sessionStorage.getItem(PENDING_SECTION_KEY);',
    },
  ],
  invalid: [
    'sessionStorage.setItem("roo_pending_section", "#faq");',
    'window.sessionStorage["getItem"]("roo_pending_section");',
    'const storage = sessionStorage; const key = "roo_pending_section"; storage.removeItem(key);',
    'const { setItem } = sessionStorage; setItem("roo_pending_section", "#faq");',
    'const key = `roo_pending_section`; sessionStorage[key] = "#faq";',
    'sessionStorage.getItem(PENDING_SECTION_KEY);',
    'import { PENDING_SECTION_KEY as key } from "./sectionNavigation"; sessionStorage.getItem(key);',
  ].map(code => ({ code, errors: [{ messageId: "owner" }] })),
});
