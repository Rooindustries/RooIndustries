import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import Footer from "../components/Footer";
import companyContent from "../lib/companyContent";

const { ABOUT_PARAGRAPHS, CONTACT_EMAIL } = companyContent;
const [ABOUT_INTRO, ...ABOUT_DETAILS] = ABOUT_PARAGRAPHS;

const ABOUT_LINKS = [
  { to: "/meet-the-team", label: "Meet the team" },
  { to: "/packages", label: "Packages" },
  { to: "/benchmarks", label: "Benchmarks" },
  { to: "/reviews", label: "Reviews" },
  { to: "/terms", label: "Service terms" },
  { to: "/privacy", label: "Privacy" },
  { to: "/contact", label: "Contact" },
];

export default function AboutPage() {
  return (
    <>
      <article className="mx-auto max-w-6xl px-5 pb-24 pt-14 text-ink sm:px-6 sm:pt-20">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-16">
          <div className="max-w-2xl">
            <h1 className="section-title">About Roo Industries</h1>
            <p className="mt-6 text-lg leading-relaxed text-ink sm:text-xl">{ABOUT_INTRO}</p>
            <div className="mt-10 space-y-6 border-t border-line-soft pt-8">
              {ABOUT_DETAILS.map((paragraph) => (
                <p key={paragraph} className="text-base leading-relaxed text-ink-secondary sm:text-[1.0625rem]">
                  {paragraph}
                </p>
              ))}
            </div>
          </div>

          <nav aria-label="About Roo Industries" className="max-w-2xl lg:max-w-none">
            <ul className="divide-y divide-line-soft overflow-hidden rounded-2xl border border-line-soft bg-surface-card">
              {ABOUT_LINKS.map(({ to, label }) => (
                <li key={to}>
                  <Link
                    to={to}
                    className="group flex min-h-12 items-center gap-4 px-5 py-3 font-semibold text-ink transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                  >
                    <span className="min-w-0 flex-1">{label}</span>
                    <ChevronRight
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-ink-muted transition-colors group-hover:text-accent"
                    />
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-4 px-1 text-sm">
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-ink-secondary underline underline-offset-4 transition-colors hover:text-ink"
              >
                {CONTACT_EMAIL}
              </a>
            </p>
          </nav>
        </div>
      </article>
      <Footer />
    </>
  );
}
