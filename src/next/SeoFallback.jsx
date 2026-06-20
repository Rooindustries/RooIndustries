const routeCopy = {
  "/": {
    title: "PC Game Optimization",
    body: "Roo Industries tunes gaming PCs for higher FPS, lower input lag, cleaner frametimes, and smoother ranked games.",
  },
  "/benchmarks": {
    title: "Benchmark Results",
    body: "Review before and after FPS numbers from real Roo Industries sessions.",
  },
  "/reviews": {
    title: "Client Reviews & Results",
    body: "Read what players say after their FPS climbs, input lag drops, and games feel smoother.",
  },
  "/contact": {
    title: "Contact Roo Industries",
    body: "Send your PC details, ask what package fits, or start a remote game tuning session.",
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
    body: "Meet the people behind Roo Industries FPS tuning, BIOS work, Windows setup, and game-specific performance sessions.",
  },
  "/tools": {
    title: "Free PC Tools & Downloads",
    body: "Grab tools for benchmarks, FPS testing, prep checks, and getting the PC ready before a session.",
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
        <div className="mx-auto max-w-4xl px-6 pt-28 pb-8 text-ink">
          <h2 className="text-4xl font-extrabold tracking-tight text-info-text">
            {copy.title}
          </h2>
          <p className="mt-4 text-base text-ink-secondary leading-relaxed">
            {copy.body}
          </p>
        </div>
      </section>
    </noscript>
  );
}
