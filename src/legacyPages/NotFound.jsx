import { Link } from "react-router-dom";
import Footer from "../components/Footer";

export default function NotFound() {
  return (
    <>
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-32 text-center">
        <h1 className="section-title">
          404
        </h1>
        <p className="section-lede">
          The page you're looking for doesn't exist.
        </p>
        <Link
          to="/"
          className="mt-8 inline-block rounded-full border border-info-border bg-info-soft px-6 py-3 text-sm font-semibold text-info-text transition hover:border-line-accent hover:bg-surface-hover-accent"
        >
          Back to Home
        </Link>
      </div>
      <Footer />
    </>
  );
}
