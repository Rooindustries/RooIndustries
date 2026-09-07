"use client";

export default function ErrorPage() {
  return (
    <main
      id="main-content"
      className="min-h-screen flex flex-col items-center justify-center gap-6 px-6 text-center bg-canvas text-ink"
    >
      <a href="/" className="text-accent font-semibold">
        Roo Industries
      </a>
      <h1 className="text-3xl font-bold">We couldn’t load this page.</h1>
      <p className="text-ink-secondary">Please reload the page to try again.</p>
      <button
        type="button"
        className="glow-button rounded-lg px-6 py-3 font-semibold"
        onClick={() => window.location.reload()}
      >
        Reload page
      </button>
      <a href="/" className="text-accent underline">Return home</a>
    </main>
  );
}
