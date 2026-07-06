import React, { useMemo, useState } from "react";
import { useParams } from "react-router-dom";

const titleFromSlug = (slug) =>
  String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

export default function DownloadGate() {
  const { slug } = useParams();
  const [orderId, setOrderId] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const downloadTitle = useMemo(() => {
    const label = titleFromSlug(slug);
    return label ? `${label} Download` : "Customer Download";
  }, [slug]);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSuccess("");

    const trimmedOrderId = orderId.trim();
    const trimmedEmail = email.trim();

    if (!trimmedOrderId) {
      setError("Please enter the Order ID from your confirmation email.");
      return;
    }

    if (!trimmedEmail) {
      setError("Please enter the email used on the booking.");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/downloads/validate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          slug,
          orderId: trimmedOrderId,
          email: trimmedEmail,
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok || !data.downloadUrl) {
        setError(
          data?.error ||
            "Could not verify this order. Check the Order ID and booking email."
        );
        return;
      }

      setSuccess("Verified. Your download is starting.");
      window.location.assign(data.downloadUrl);
    } catch (err) {
      console.error("Download validation failed:", err);
      setError("Something went wrong while verifying this order. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="relative z-10 pt-32 pb-24 px-6 max-w-3xl mx-auto text-ink">
      <h1 className="text-4xl sm:text-5xl font-extrabold text-center text-info-text drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        {downloadTitle}
      </h1>
      <p className="mt-3 text-ink-secondary text-center text-sm sm:text-base">
        Enter the Order ID and booking email from your Roo Industries
        confirmation email to start the download.
      </p>

      <form
        onSubmit={handleSubmit}
        className="mt-8 rounded-2xl border border-line-input bg-surface-card shadow-[var(--shadow-card-glow-info)] backdrop-blur-md p-6 sm:p-7"
      >
        <div className="mb-4">
          <label className="block text-sm font-semibold mb-2" htmlFor="email">
            Booking email
          </label>
          <input
            id="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Email used on the booking"
            className="w-full bg-surface-input border border-line-input rounded-md px-3 py-2 outline-none text-sm"
            type="email"
            autoComplete="email"
          />
        </div>

        <div className="mb-5">
          <label className="block text-sm font-semibold mb-2" htmlFor="orderId">
            Order ID
          </label>
          <input
            id="orderId"
            value={orderId}
            onChange={(event) => setOrderId(event.target.value)}
            placeholder="Paste the Order ID from your confirmation email"
            className="w-full bg-surface-input border border-line-input rounded-md px-3 py-2 outline-none text-sm"
            autoComplete="off"
          />
        </div>

        {error && (
          <p className="mb-4 text-sm text-danger-text bg-danger-soft border border-danger-border rounded-md px-3 py-2">
            {error}
          </p>
        )}

        {success && (
          <p className="mb-4 text-sm text-success-text bg-success-soft border border-success-border rounded-md px-3 py-2">
            {success}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="glow-button w-full px-4 py-3 rounded-md font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60 text-sm"
        >
          {loading ? "Verifying..." : "Verify and Download"}
          <span className="glow-line glow-line-top" />
          <span className="glow-line glow-line-right" />
          <span className="glow-line glow-line-bottom" />
          <span className="glow-line glow-line-left" />
        </button>
      </form>
    </section>
  );
}
