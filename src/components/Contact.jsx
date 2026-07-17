import React, { useEffect, useRef, useState } from "react";
import { useForm, ValidationError } from "@formspree/react";
import { getPublicContent } from "../lib/publicContentClient";

export default function Contact() {
  const [contactData, setContactData] = useState(null);
  const [copyStatus, setCopyStatus] = useState("idle");
  const copyResetTimeoutRef = useRef(null);

  const [state, handleSubmit] = useForm("mpwybpen");

  useEffect(() => {
    getPublicContent("contact")
      .then(setContactData)
      .catch(console.error);
  }, []);

  useEffect(
    () => () => {
      if (copyResetTimeoutRef.current) {
        clearTimeout(copyResetTimeoutRef.current);
      }
    },
    []
  );

  const resetCopyStatusLater = () => {
    if (copyResetTimeoutRef.current) {
      clearTimeout(copyResetTimeoutRef.current);
    }
    copyResetTimeoutRef.current = setTimeout(() => {
      setCopyStatus("idle");
      copyResetTimeoutRef.current = null;
    }, 2000);
  };

  const handleCopy = async () => {
    const email = contactData?.email || "serviroo@rooindustries.com";
    setCopyStatus("copying");

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(email);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }

    resetCopyStatusLater();
  };

  return (
    <section className="text-ink px-4 py-28 flex flex-col items-center">
      {/* Heading */}
      <div className="text-center mb-10">
        <h2 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-info-text drop-shadow-[0_0_15px_rgba(56,189,248,0.5)] mb-2">
          {contactData?.title || "Get In Touch"}
        </h2>
        <p className="text-ink-secondary text-lg">
          {contactData?.subtitle ||
            "Ready to optimize your PC? Let's discuss how I can help improve your system's performance."}
        </p>
      </div>

      {/* Email block */}
      <div className="p-4 rounded-lg flex items-center justify-between w-full max-w-xl mb-8 border border-line-input bg-surface-card backdrop-blur-sm">
        <div className="flex items-center space-x-3">
          <svg
            className="w-6 h-6 text-accent"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <path d="M2 4a2 2 0 012-2h16a2 2 0 012 2v1.8l-10 6.25L2 5.8V4zm0 4.2V20a2 2 0 002 2h16a2 2 0 002-2V8.2l-10 6.25L2 8.2z" />
          </svg>
          <span className="text-lg font-medium">
            {contactData?.email || "serviroo@rooindustries.com"}
          </span>
        </div>
        <button
          type="button"
          className="text-accent hover:text-[color:var(--color-link-hover)] transition duration-200"
          onClick={handleCopy}
          disabled={copyStatus === "copying"}
        >
          {copyStatus === "copied"
            ? "Copied!"
            : copyStatus === "copying"
            ? "Copying..."
            : "Copy"}
        </button>
      </div>
      {copyStatus === "failed" ? (
        <p
          className="-mt-5 mb-8 w-full max-w-xl text-sm text-danger-text"
          role="status"
          aria-live="polite"
        >
          Copy failed. Select the email address and copy it manually.
        </p>
      ) : null}

      {/* Contact Form */}
      {state.succeeded ? (
        <div className="w-full max-w-xl p-6 rounded-lg border border-success-border bg-success-soft backdrop-blur-sm text-center text-success-text font-semibold">
          Thank you! Your message has been sent.
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="p-6 rounded-lg w-full max-w-xl space-y-5 border border-line-input bg-surface-card backdrop-blur-sm"
        >
          <div>
            <label className="block mb-1 font-semibold">Name</label>
            <input
              type="text"
              name="name"
              placeholder="Your name"
              required
              className="w-full p-3 bg-surface-input rounded text-ink border border-line-input focus:border-info-border focus:outline-none placeholder:text-ink-muted"
            />
            <ValidationError prefix="Name" field="name" errors={state.errors} />
          </div>
          <div>
            <label className="block mb-1 font-semibold">Email</label>
            <input
              type="email"
              name="email"
              placeholder="your.email@example.com"
              required
              className="w-full p-3 bg-surface-input rounded text-ink border border-line-input focus:border-info-border focus:outline-none placeholder:text-ink-muted"
            />
            <ValidationError
              prefix="Email"
              field="email"
              errors={state.errors}
            />
          </div>
          <div>
            <label className="block mb-1 font-semibold">Message</label>
            <textarea
              name="message"
              placeholder="Tell me about your PC and what you'd like to optimize..."
              rows="5"
              required
              className="w-full p-3 bg-surface-input rounded text-ink border border-line-input focus:border-info-border focus:outline-none placeholder:text-ink-muted"
            ></textarea>
            <ValidationError
              prefix="Message"
              field="message"
              errors={state.errors}
            />
          </div>

          <button
            type="submit"
            disabled={state.submitting}
            className="glow-button w-full text-white font-semibold py-3 rounded transition duration-200 inline-flex items-center justify-center gap-2"
          >
            Send Message
            <span className="glow-line glow-line-top" />
            <span className="glow-line glow-line-right" />
            <span className="glow-line glow-line-bottom" />
            <span className="glow-line glow-line-left" />
          </button>

          <p className="text-sm text-ink-muted text-center pt-2">
            Your message will be sent{" "}
            <span className="text-ink font-medium">directly</span> to{" "}
            {contactData?.email || "serviroo@rooindustries.com"}
          </p>
        </form>
      )}

      <div className="h-3" />

      {/* Designed by Nerky */}
      <p className="mt-4 text-xs text-ink-muted">
        Designed by{" "}
        <a
          href="https://discord.com/users/286457824081346570"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:text-[color:var(--color-link-hover)] underline transition-colors"
        >
          Nerky
        </a>{" "}
        &{" "}
        <a
          href="https://discord.com/users/1074948989083979837"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:text-[color:var(--color-link-hover)] underline transition-colors"
        >
          Exyy
        </a>
      </p>
    </section>
  );
}
