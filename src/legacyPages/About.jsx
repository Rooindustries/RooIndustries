import { Link } from "react-router-dom";
import Footer from "../components/Footer";
import companyContent from "../lib/companyContent";

const { ABOUT_PARAGRAPHS, CONTACT_EMAIL } = companyContent;

export default function AboutPage() {
  return (
    <>
      <article className="py-28 max-w-3xl mx-auto p-6 text-ink">
        <h1 className="text-3xl font-bold mb-6">About Roo Industries</h1>
        {ABOUT_PARAGRAPHS.map((paragraph) => (
          <p key={paragraph} className="mb-4 leading-relaxed text-ink-secondary">
            {paragraph}
          </p>
        ))}
        <nav aria-label="About Roo Industries" className="flex flex-wrap gap-4 text-accent underline underline-offset-2">
          <Link to="/meet-the-team">Meet the team</Link>
          <Link to="/packages">Packages</Link>
          <Link to="/benchmarks">Benchmarks</Link>
          <Link to="/reviews">Reviews</Link>
          <Link to="/terms">Service terms</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/contact">Contact</Link>
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </nav>
      </article>
      <Footer />
    </>
  );
}
