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
    `function Steps() { const data = { history: [] }; setTimeout(() => data.history.push("step")); return null; }`,
  ],
  invalid: [
    {
      name: "aliased router push from a timer",
      code: `function Pay() {
        const pageRouter = useRouter(); setTimeout(() => pageRouter.push("/payment"), 300); return null; }`,
      errors: [{ messageId: "timer" }],
    },
    {
      name: "router prop alias push from a timer",
      code: `function Pay({ providedRouter }) {
        const router = providedRouter; setTimeout(() => router.push("/payment"), 300); return null; }`,
      errors: [{ messageId: "timer" }],
    },
    {
      name: "router spread over a placeholder",
      code: `function Pay(props) {
        const data = { router: null, ...props }; setTimeout(() => data.router.push("/payment")); return null; }`,
      errors: [{ messageId: "timer" }],
    },
    {
      name: "router from a factory call",
      code: `function Pay() {
        const data = { router: getRouter() }; setTimeout(() => data.router.push("/payment")); return null; }`,
      errors: [{ messageId: "timer" }],
    },
    {
      name: "router prop push from a timer",
      code: `function Pay({ router }) { setTimeout(() => router.push("/payment"), 300); return null; }`,
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

run("fetch-needs-deadline", {
  valid: [
    `fetch("/api/ref/payouts", { signal: requestDeadline() });`,
    `function load(url, options) { return fetch(url, { ...options }); }`,
    `function load(url, options) { return fetch(url, options); }`,
    `const options = { signal: requestDeadline() }; fetch(url, options);`,
    `const base = { signal: requestDeadline() }; fetch(url, { ...base, method: "POST" });`,
  ],
  invalid: [
    {
      name: "signal cleared with null",
      code: `fetch(url, { signal: null });`,
      errors: [{ messageId: "missing" }],
    },
    {
      name: "deadline replaced by a later spread",
      code: `const reset = { signal: undefined }; fetch(url, { signal: requestDeadline(), ...reset });`,
      errors: [{ messageId: "missing" }],
    },
    {
      name: "named options without a signal",
      code: `const options = { method: "POST" }; fetch(url, options);`,
      errors: [{ messageId: "missing" }],
    },
    {
      name: "spread options without a signal",
      code: `const base = { headers }; fetch(url, { ...base, method: "POST" });`,
      errors: [{ messageId: "missing" }],
    },
    {
      name: "RefDashboard payouts request before #216",
      code: `async function load() { const res = await fetch("/api/ref/payouts"); }`,
      errors: [{ messageId: "missing" }],
    },
    {
      name: "Razorpay lookup before #148",
      code: "fetch(`https://api.razorpay.com/v1/orders/${id}/payments`, { headers: { Authorization: auth } });",
      errors: [{ messageId: "missing" }],
    },
  ],
});

run("no-ignored-write-request", {
  valid: [
    `const res = await fetch("/api/releaseHold", { method: "POST" }); if (!res.ok) throw new Error();`,
    `fetch("/api/payment/quote", { method: "POST" }).then((response) => response.json());`,
    `fetch("/api/ref/updateSplit", { method: "POST" }).then(handleResponse);`,
  ],
  invalid: [
    {
      name: "success shown without reading the response",
      code: `fetch("/api/ref/register", { method: "POST" }).then(() => navigate("/referrals/dashboard"));`,
      errors: [{ messageId: "ignored" }],
    },
    {
      name: "named write options left unchecked",
      code: `const options = { method: "POST", signal }; fetch("/api/releaseHold", options);`,
      errors: [{ messageId: "ignored" }],
    },
    {
      name: "write method from a spread left unchecked",
      code: `const base = { method: "POST" }; fetch("/api/releaseHold", { ...base, signal });`,
      errors: [{ messageId: "ignored" }],
    },
    {
      name: "window.fetch write left unchecked",
      code: `window.fetch("/api/releaseHold", { method: "POST" });`,
      errors: [{ messageId: "ignored" }],
    },
    {
      name: "ReservationBanner release before #209",
      code: `fetch("/api/releaseHold", { method: "POST", body }).catch(() => console.error("release failed"));`,
      errors: [{ messageId: "ignored" }],
    },
    {
      name: "BookingForm release before #158",
      code: `async function release() { await fetch("/api/releaseHold", { method: "POST", body }); }`,
      errors: [{ messageId: "ignored" }],
    },
  ],
});

run("no-aria-label-on-generic", {
  valid: [
    `<p role="img" aria-label="5 out of 5 stars">★★★★★</p>`,
    `<nav aria-label="Footer" />`,
    `<div role={scoreRole} aria-label="Grand final">4–1</div>`,
  ],
  invalid: [
    {
      name: "PriceDisplay before #161",
      code: `<div className="price" aria-label={oldPrice ? "Sale price" : "Price"}>$54.95</div>`,
      errors: [{ messageId: "generic" }],
    },
    {
      name: "Empty and name-prohibiting roles",
      code: `<><div role="" aria-label="Price">$54.95</div><span role="presentation" aria-label="Sale">-20%</span>
        <p role=" Generic " aria-label="Rating">5</p></>`,
      errors: [{ messageId: "generic" }, { messageId: "generic" }, { messageId: "generic" }],
    },
    {
      name: "Grand final score before the role fix",
      code: `<div className="tourney-final-score" aria-label={\`Grand final: \${champion}\`}><span>Grand final</span></div>`,
      errors: [{ messageId: "generic" }],
    },
  ],
});
