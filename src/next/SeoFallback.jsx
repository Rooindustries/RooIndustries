const routeCopy = {
  "/": {
    title: "Professional PC Optimization",
    body: "Roo Industries delivers online PC optimization, BIOS tuning, and game performance improvements with stability-first workflows and measurable results.",
  },
  "/benchmarks": {
    title: "Benchmark Results",
    body: "Review before-and-after benchmark improvements from real optimization sessions.",
  },
  "/reviews": {
    title: "Client Reviews & Results",
    body: "Read verified customer feedback about FPS gains, latency improvements, and system stability.",
  },
  "/faq": {
    title: "Frequently Asked Questions",
    body: "Find answers about process, safety, expectations, and optimization outcomes.",
  },
  "/contact": {
    title: "Contact Roo Industries",
    body: "Reach out for questions, booking support, and service guidance.",
  },
  "/terms": {
    title: "Terms & Conditions",
    body: "Read service terms, booking policy, and limitations.",
  },
  "/privacy": {
    title: "Privacy Policy",
    body: "Understand how Roo Industries handles and protects your personal information.",
  },
  "/meet-the-team": {
    title: "Meet The Team",
    body: "Learn about the specialists behind Roo Industries optimization sessions.",
  },
  "/tools": {
    title: "Free PC Tools & Downloads",
    body: "Access free tools and resources for diagnostics, benchmarking, and pre-session preparation.",
  },
  "/referrals/login": {
    title: "Referral Partner Login",
    body: "Sign in to your referral portal to monitor clicks, conversions, and payout progress.",
  },
  "/referrals/register": {
    title: "Referral Program Sign Up",
    body: "Create a partner account and start sharing your unique referral link.",
  },
};

export default function SeoFallback({ pathname }) {
  const copy = routeCopy[pathname];
  if (!copy) return null;

  return (
    <noscript>
      <section aria-label="No-JS SEO fallback">
        <div className="mx-auto max-w-4xl px-6 pt-28 pb-8 text-white">
          <h1 className="text-4xl font-extrabold tracking-tight text-sky-100">
            {copy.title}
          </h1>
          <p className="mt-4 text-base text-slate-200/90 leading-relaxed">
            {copy.body}
          </p>
        </div>
      </section>
    </noscript>
  );
}
