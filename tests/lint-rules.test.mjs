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
    "<span className={`bg-accent ${active ? \"text-accent-contrast\" : \"text-ink\"}`} />",
  ],
  invalid: [
    {
      name: "white text in one branch of a conditional class",
      code: "<span className={`bg-accent ${active ? \"text-white\" : \"text-black\"}`} />",
      errors: [{ messageId: "contrast" }],
    },
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
    {
      name: "creator portal toast before the contrast fix",
      code: "<div className={`rounded-xl text-white ${ok ? \"bg-success\" : \"bg-danger\"}`} />",
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
    `fetch(url, { ["signal"]: requestDeadline() });`,
    `const base = { signal: requestDeadline() }; const cleared = { signal: null }; fetch(url, { ...base, ...cleared, ...base });`,
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
    `const read = { method: "GET" }; const write = { method: "POST" }; fetch("/api/ref/split", { ...read, ...write, ...read });`,
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
      name: "quoted method key left unchecked",
      code: `fetch("/api/releaseHold", { "method": "POST" });`,
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
    `<span {...badgeProps} aria-label="Verified creator">✓</span>`,
    `<span role="generic" {...badgeProps} aria-label="Verified creator">✓</span>`,
    `<div role="group generic" aria-label="Score">4–1</div>`,
    `<div role="switchy img" aria-label="Rating">★★★</div>`,
    `<div role="sectionheader" aria-label="Packages">Packages</div>`,
    `<div role="doc-abstract" aria-label="Summary">…</div>`,
    `<div role="graphics-document" aria-label="Bracket">…</div>`,
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
        <p role=" Generic " aria-label="Rating">5</p><span role="code" aria-label="Order">A1</span>
        <span role="emphasis" aria-label="Note">!</span></>`,
      errors: [
        { messageId: "generic" },
        { messageId: "generic" },
        { messageId: "generic" },
        { messageId: "generic" },
        { messageId: "generic" },
      ],
    },
    {
      name: "absent and unrecognized roles",
      code: `<><span role={null} aria-label="Sale">-20%</span><span role={false} aria-label="New">!</span>
        <div role="grop" aria-label="Score">4–1</div><div role="grop generic" aria-label="Score">4–1</div>
        <div role="graphics-dooc" aria-label="Bracket">…</div></>`,
      errors: [
        { messageId: "generic" },
        { messageId: "generic" },
        { messageId: "generic" },
        { messageId: "generic" },
        { messageId: "generic" },
      ],
    },
    {
      name: "explicit role after a spread, and a role list led by a generic role",
      code: `<><span {...badgeProps} role="generic" aria-label="Verified">✓</span>
        <div role="presentation group" aria-label="Score">4–1</div></>`,
      errors: [{ messageId: "generic" }, { messageId: "generic" }],
    },
    {
      name: "Grand final score before the role fix",
      code: `<div className="tourney-final-score" aria-label={\`Grand final: \${champion}\`}><span>Grand final</span></div>`,
      errors: [{ messageId: "generic" }],
    },
  ],
});

run("inputs-need-form", {
  valid: [
    `function Help() { return <div><input /><button onClick={() => { const later = () => saveDraft();
      openHelp(later); }}>Help</button></div>; }`,
    `function Upgrade() { return <form onSubmit={handleCheckOrder}><input type="email" /><button
      type="submit">Check</button></form>; }`,
    `function Share() { return <div><input value={link} readOnly /><button onClick={save}>Save</button></div>; }`,
    `function Fields() { return <div><input /><button onClick={() => move(1)}>Down</button></div>; }`,
    `function Docs() { return <div><input type="search" /><button onClick={() => { if (confirmDiscard())
      startNewDocument(type.name); }}>New</button></div>; }`,
    `function Gate() { return <div><input /><button onClick={() => { switch (validateCode()) { case true:
      openNext(); } }}>Next</button></div>; }`,
    `function Help() { return <div><input /><button onClick={() => { switch (mode) { case checkMode(): openHelp(); }
      }}>Help</button></div>; }`,
    `function Rows() { return <div><input /><button onClick={() => { for (const row of checkedRows()) mark(row); }}>
      Mark</button></div>; }`,
    `function Ready() { return <div><input /><button onClick={() => { const ready = checkReady(); if (ready) openHelp();
      }}>Help</button></div>; }`,
    `function Retry() { return <div><input /><button onClick={() => { for (; checkReady(); ) wait(); }}>
      Wait</button></div>; }`,
  ],
  invalid: [
    {
      name: "UpgradeLink check before #236",
      code: `function UpgradeLink() { return <div><input type="email" /><input placeholder="Order ID" /><button
        onClick={handleCheckOrder}>Check eligibility</button></div>; }`,
      errors: [{ messageId: "form" }, { messageId: "form" }],
    },
    {
      name: "search and explicitly editable fields",
      code: `function Finder() { return <div><input type="search" /><input readOnly={false} /><button
        onClick={handleSubmit}>Find</button></div>; }`,
      errors: [{ messageId: "form" }, { messageId: "form" }],
    },
    {
      name: "async block-bodied submit handler",
      code: `function Redeem() { return <div><input type="email" /><button onClick={async () => { await
        handleSubmit(); }}>Redeem</button></div>; }`,
      errors: [{ messageId: "form" }],
    },
    {
      name: "submit after an early return",
      code: `function Send() { return <div><input /><button onClick={() => { if (!validateCode()) return;
        form.submit(); }}>Send</button></div>; }`,
      errors: [{ messageId: "form" }],
    },
    {
      name: "submit settled with then",
      code: `function Code() { return <div><input /><button onClick={() => saveCode().then(close)}>Save</button></div>; }`,
      errors: [{ messageId: "form" }],
    },
    {
      name: "submit behind a logical guard",
      code: `function Send() { return <div><input /><button onClick={() => ready && handleSubmit()}>Send</button></div>; }`,
      errors: [{ messageId: "form" }],
    },
    {
      name: "function handler calling a member save",
      code: `function Keep() { return <div><input type="tel" /><button onClick={function () {
        void props.saveCode(); }}>Keep</button></div>; }`,
      errors: [{ messageId: "form" }],
    },
  ],
});

run("no-client-only-public-content", {
  valid: [
    `export default function Terms(props) { const [data, setData] = useState(props.initialData); useEffect(() =>
      { getPublicContent("terms").then(setData); }, []); return <p>{data}</p>; }`,
    `export default function Terms({ initialData }) { const [data, setData] = useState(initialData); useEffect(() =>
      { getPublicContent("terms").then(setData); }, []); return <p>{data}</p>; }`,
    `export default function Terms(props) { const { initialData: seed = null } = props; const [data, setData] =
      useState(seed); useEffect(() => { getPublicContent("terms").then(setData); }, []); return <p>{data}</p>; }`,
    `export default function Faq(props) { const [data, setData] = useState(props["initialFaq"]); useEffect(() =>
      { getPublicContent("faq").then(setData); }, []); return <p>{data}</p>; }`,
    `export default function Terms({ initialData } = {}) { const [data, setData] = useState(initialData); useEffect(() =>
      { getPublicContent("terms").then(setData); }, []); return <p>{data}</p>; }`,
    `export default function Terms(props = {}) { const [data, setData] = useState(props.initialData); useEffect(() =>
      { getPublicContent("terms").then(setData); }, []); return <p>{data}</p>; }`,
    `export default function Terms(props) { const { ["initialData"]: seed } = props; const [data, setData] =
      useState(seed); useEffect(() => { getPublicContent("terms").then(setData); }, []); return <p>{data}</p>; }`,
    `export default function Faq(props) { const [data, setData] = useState(props[\`initialFaq\`]); useEffect(() =>
      { getPublicContent("faq").then(setData); }, []); return <p>{data}</p>; }`,
    `export default function Upgrade({ slug }) { useEffect(() => { getPublicContent("upgrade", { slug }); },
      [slug]); return null; }`,
  ],
  invalid: [
    {
      name: "Terms before #195",
      code: `export default function Terms() { const [data, setData] = useState(null); useEffect(() => {
        getPublicContent("terms").then((d) => setData(d)); }, []); return <p>{data}</p>; }`,
      errors: [{ messageId: "clientOnly" }],
    },
    {
      name: "an inner callback's own props parameter",
      code: `export default function List(props) { const rows = props.items.map((props) => { const { initialData }
        = props; return initialData; }); const [data, setData] = useState(null); useEffect(() => {
        getPublicContent("list").then(setData); }, []); return <p>{data}{rows}</p>; }`,
      errors: [{ messageId: "clientOnly" }],
    },
    {
      name: "a bare props parameter with no initial data",
      code: `export default function Terms(props) { const [data, setData] = useState(null); useEffect(() => {
        getPublicContent("terms").then(setData); }, []); return <p>{data}</p>; }`,
      errors: [{ messageId: "clientOnly" }],
    },
  ],
});

run("no-hidden-server-motion", {
  valid: [
    `function About() { return <motion.div initial={false} animate={{ opacity: 1 }}>Hi</motion.div>; }`,
    `function Dialog({ open }) { return <AnimatePresence>{open && <motion.div initial={{ opacity: 0 }} animate={{
      opacity: 1 }} />}</AnimatePresence>; }`,
    `function Fade() { return <motion.div initial={{ ["opacity"]: 0, opacity: 1 }} animate={{ opacity: 1 }} />; }`,
    `function Fade() { const shown = { opacity: 1 }; const hidden = { opacity: 0 }; return <motion.div
      initial={{ ...shown, ...hidden, ...shown }} animate={{ opacity: 1 }} />; }`,
    `function Fade() { return <motion.div initial={{ ["opacity"]: 0, ...{ opacity: 1 } }} animate={{ opacity: 1 }} />; }`,
    `function Pay() { const variants = { ["hidden"]: { opacity: 0 }, hidden: { opacity: 1 } }; return <motion.section
      variants={variants} initial="hidden" animate="hidden" />; }`,
  ],
  invalid: [
    {
      name: "spread that hides last",
      code: `function Fade() { const start = { opacity: 0 }; return <motion.div initial={{ opacity: 1, ...start }}
        animate={{ opacity: 1 }} />; }`,
      errors: [{ messageId: "hidden" }],
    },
    {
      name: "computed opacity key that wins",
      code: `function Fade() { return <motion.div initial={{ opacity: 1, ["opacity"]: 0 }} animate={{ opacity: 1 }} />; }`,
      errors: [{ messageId: "hidden" }],
    },
    {
      name: "About section before #229",
      code: `function About() { return <motion.div initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0
        }}>Proof</motion.div>; }`,
      errors: [{ messageId: "hidden" }],
    },
    {
      name: "variant that starts hidden",
      code: `function Pay() { const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1 } };
        return <motion.section variants={containerVariants} initial="hidden" animate="visible" />; }`,
      errors: [{ messageId: "hidden" }],
    },
    {
      name: "always-mounted child inside AnimatePresence",
      code: `function Hero() { return <AnimatePresence><motion.div initial={{ opacity: 0 }} animate={{ opacity: 1
        }}>Hero</motion.div></AnimatePresence>; }`,
      errors: [{ messageId: "hidden" }],
    },
  ],
});

run("no-nested-components", {
  valid: [
    `const VideoBadge = ({ name }) => <span>{name}</span>; export default function HowItWorks() { return <VideoBadge
      name="a" />; }`,
    `export default function List({ items }) { return items.map((item) => <li key={item}>{item}</li>); }`,
  ],
  invalid: [
    {
      name: "HowItWorks VideoBadge before #250",
      code: `export default function HowItWorks() {
        const VideoBadge = ({ name, pauseVideos }) => { return <span>{name}</span>; };
        return <VideoBadge name="a" />; }`,
      errors: [{ messageId: "nested" }],
    },
    {
      name: "expression-bodied component with no children",
      code: `export default function Card() { const Divider = () => <hr />; return <Divider />; }`,
      errors: [{ messageId: "nested" }],
    },
  ],
});
