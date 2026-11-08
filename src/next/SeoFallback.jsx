const routeCopy = {
  "/reviews": {
    title: "Client Reviews & Results",
    body: "Read what players say after their FPS climbs, input lag drops, and games feel smoother.",
  },
  "/tools": {
    title: "Free PC Tools & Downloads",
    body: "Grab tools for benchmarks, FPS testing, prep checks, and getting the PC ready before a session.",
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
        <div className="mx-auto max-w-4xl px-6 pt-28 pb-8 text-center text-ink">
          <h2 className="section-title">
            {copy.title}
          </h2>
          <p className="section-lede">
            {copy.body}
          </p>
        </div>
      </section>
    </noscript>
  );
}
