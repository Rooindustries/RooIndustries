import { describe, it } from "node:test";
import { RuleTester } from "eslint";
import { rules } from "../eslint-rules/index.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const run = (name, cases) => tester.run(name, rules[name], cases);

run("aria-label-keeps-visible-text", {
  valid: [
    `<a aria-label="Roo Industries home" href="/">Roo Industries</a>`,
    `<button aria-label="Close dialog">×</button>`,
    `<button aria-label="Open menu"><span aria-hidden={true}>×</span>Open menu</button>`,
    `<a aria-label="Home" href="/"><img src="/logo.png" alt="Company logo" />Home</a>`,
  ],
  invalid: [
    {
      name: "Navbar brand link before #192",
      code: `<Link to="/" aria-label="Go to Roo Industries home"><span>Roo Industries</span><span>Precision Performance
        Engineering</span></Link>`,
      errors: [{ messageId: "mismatch" }],
    },
  ],
});

run("no-low-contrast-text", {
  valid: [
    `<button className="bg-accent-strong hover:bg-accent text-accent-contrast" />`,
    `<div className="bg-danger text-black" />`,
  ],
  invalid: [
    {
      name: "RefLogin button before #161",
      code: `<button className="px-5 py-2 rounded-xl bg-accent-strong hover:bg-accent text-white" />`,
      errors: [{ messageId: "contrast" }],
    },
    {
      name: "Benchmarks badge before #203",
      code: "<div className={`bg-danger text-white text-xs ${extra}`} />",
      errors: [{ messageId: "contrast" }],
    },
  ],
});

run("aria-expanded-needs-controls", {
  valid: [`<button aria-expanded={open} aria-controls="faq-answer-1" />`],
  invalid: [
    {
      name: "FAQ toggle before #199",
      code: `<button aria-expanded={isAnswerOpen} onClick={toggle}>Question</button>`,
      errors: [{ messageId: "controls" }],
    },
  ],
});

run("no-unguarded-timer-navigation", {
  valid: [
    `function RefLogin() { useEffect(() => { const id = setTimeout(() => nav("/x"), 500); return () =>
      clearTimeout(id); }, []); return null; }`,
    `function Toast() { setTimeout(() => setToast((current) => (current === next ? null : current)), 2800); return null;
      }`,
    `function Queue() {
      setTimeout(() => items.push(next), 100); setTimeout(() => text.replace("a", "b")); return null; }`,
    `function Log() { const history = []; setTimeout(() => history.push("step"), 100); return null; }`,
  ],
  invalid: [
    {
      name: "aliased router push from a timer",
      code: `function Pay() {
        const pageRouter = useRouter(); setTimeout(() => pageRouter.push("/payment"), 300); return null; }`,
      errors: [{ messageId: "timer" }],
    },
    {
      name: "router push from a timer",
      code: `function Checkout() { setTimeout(() => router.push("/payment"), 300); return null; }`,
      errors: [{ messageId: "timer" }],
    },
    {
      name: "RefLogin redirect before #211",
      code: `function RefLogin() {
        async function submit() { setTimeout(() => nav("/referrals/dashboard"), 500); } return null; }`,
      errors: [{ messageId: "timer" }],
    },
    {
      name: "RefRegister toast reset before #205",
      code: `function RefRegister() { function showToast() { setTimeout(() => setToast(null), 2800); } return null; }`,
      errors: [{ messageId: "timer" }],
    },
  ],
});

run("no-bare-route-prefix", {
  valid: [`pathName === "/booking" || pathName.startsWith("/booking/");`, `name.startsWith("/booking");`],
  invalid: [
    {
      name: "App route check before #188",
      code: `const isBooking = pathName.startsWith("/booking");`,
      errors: [{ messageId: "prefix" }],
    },
  ],
});

run("input-needs-label", {
  valid: [
    `<><label htmlFor="booking-discord">Discord username</label><input id="booking-discord" aria-label="Discord
      username" /></>`,
    `<input type="search" aria-label="Search creators" />`,
    `<input aria-label={ariaLabel} />`,
  ],
  invalid: [
    {
      name: "Booking details field before #190",
      code: `<input name="discord" aria-label="Discord username" />`,
      errors: [{ messageId: "label" }],
    },
  ],
});

run("no-hand-built-dollars", {
  valid: ["const line = `${formatMoney(booking.netAmount, booking.currency)} paid`;"],
  invalid: [
    {
      name: "Booking email amount before #163",
      code: "const line = `$${formatMoney(booking.netAmount)}`;",
      errors: [{ messageId: "dollars" }],
    },
  ],
});
