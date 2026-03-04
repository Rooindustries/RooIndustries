import { Link } from "react-router-dom";
import SEO from "../components/SEO";
import Footer from "../components/Footer";

export default function NotFound() {
  return (
    <>
      <SEO
        title="Page Not Found | Roo Industries"
        description="The page you're looking for doesn't exist."
        noindex
      />
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-32 text-center">
        <h1 className="text-6xl font-extrabold text-sky-100 drop-shadow-[0_0_20px_rgba(56,189,248,0.35)]">
          404
        </h1>
        <p className="mt-4 text-lg text-slate-200/80">
          The page you're looking for doesn't exist.
        </p>
        <Link
          to="/"
          className="mt-8 inline-block rounded-full border border-sky-500/40 bg-sky-900/50 px-6 py-3 text-sm font-semibold text-white transition hover:border-cyan-300/60 hover:bg-sky-800/60"
        >
          Back to Home
        </Link>
      </div>
      <Footer />
    </>
  );
}
