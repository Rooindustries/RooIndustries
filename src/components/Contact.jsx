import React, { useEffect, useRef, useState } from "react";
import { getPublicContent } from "../lib/publicContentClient";
import companyContent from "../lib/companyContent";

const { CONTACT_GUIDANCE, CONTACT_EMAIL } = companyContent;

const INPUT_CLASS = [
  "w-full p-3 bg-surface-input rounded text-ink border border-line-input",
  "focus:border-info-border focus:outline-none placeholder:text-ink-muted",
].join(" ");

const SENT_NOTICE = [
  "w-full max-w-xl p-6 rounded-lg border border-success-border bg-success-soft backdrop-blur-sm",
  "text-center text-success-text font-semibold",
].join(" ");

const FieldError = ({ id, message }) =>
  message ? (
    <p id={id} className="mt-1 text-sm text-danger-text">
      {message}
    </p>
  ) : null;

export default function Contact({ initialData = null }) {
  const [contactData, setContactData] = useState(initialData);
  const [submission, setSubmission] = useState({ state: "idle", fields: {}, error: "" });
  const [copyStatus, setCopyStatus] = useState("idle");
  const copyResetTimeoutRef = useRef(null);

  const contactEmail = contactData?.email || CONTACT_EMAIL;
  const sending = submission.state === "sending";

  const submitMessage = async (event) => {
    event.preventDefault();
    if (sending) return;
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(
      ["name", "email", "message", "company"].map((field) => [field, String(form.get(field) || "")])
    );
    setSubmission({ state: "sending", fields: {}, error: "" });
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
      const result = await response.json().catch(() => ({}));
      if ((response.status === 200 || response.status === 202) && result?.ok) {
        setSubmission({ state: "sent", fields: {}, error: "" });
        return;
      }
      if (response.status === 400 && result?.fields) {
        setSubmission({ state: "invalid", fields: result.fields, error: "" });
        return;
      }
      setSubmission({ state: "failed", fields: {}, error: response.status === 429 ? "limited" : "failed" });
    } catch {
      setSubmission({ state: "failed", fields: {}, error: "failed" });
    }
  };

  const fieldProps = (field) =>
    submission.fields[field]
      ? { "aria-invalid": true, "aria-describedby": `contact-${field}-error` }
      : {};

  useEffect(() => {
    let active = true;
    getPublicContent("contact")
      .then((data) => {
        if (!active) return;
        if (data) setContactData(data);
      })
      .catch(() => {});
    return () => { active = false; };
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
    const email = contactEmail;
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
    <section className="text-ink px-4 pb-28 page-top flex flex-col items-center">
      <div className="text-center mb-10">
        <h1 className="section-title">
          {contactData?.title || "Get In Touch"}
        </h1>
        <p className="section-lede">
          {contactData?.subtitle ||
            "Ready to optimize your PC? Let's discuss how I can help improve your system's performance."}
        </p>
      </div>

      <div className="p-4 rounded-lg flex items-center justify-between w-full max-w-xl mb-8 border border-line-input bg-surface-card backdrop-blur-sm">
        <div className="flex items-center space-x-3">
          <svg
            className="w-6 h-6 text-accent"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <path d="M2 4a2 2 0 012-2h16a2 2 0 012 2v1.8l-10 6.25L2 5.8V4zm0 4.2V20a2 2 0 002 2h16a2 2 0 002-2V8.2l-10 6.25L2 8.2z" />
          </svg>
          <a href={`mailto:${contactEmail}`} className="text-lg font-medium">
            {contactEmail}
          </a>
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

      {submission.state === "sent" ? (
        <div
          className={SENT_NOTICE}
          role="status"
        >
          Thanks, your message is in. We'll reply by email.
        </div>
      ) : (
        <form
          onSubmit={submitMessage}
          className="p-6 rounded-lg w-full max-w-xl space-y-5 border border-line-input bg-surface-card backdrop-blur-sm"
        >
          <div>
            <label htmlFor="contact-name" className="block mb-1 font-semibold">Name</label>
            <input
              type="text"
              id="contact-name"
              name="name"
              placeholder="Your name"
              required
              maxLength={100}
              className={INPUT_CLASS}
              {...fieldProps("name")}
            />
            <FieldError id="contact-name-error" message={submission.fields.name} />
          </div>
          <div>
            <label htmlFor="contact-email" className="block mb-1 font-semibold">Email</label>
            <input
              type="email"
              id="contact-email"
              name="email"
              placeholder="your.email@example.com"
              required
              className={INPUT_CLASS}
              {...fieldProps("email")}
            />
            <FieldError id="contact-email-error" message={submission.fields.email} />
          </div>
          <div>
            <label htmlFor="contact-message" className="block mb-1 font-semibold">Message</label>
            <textarea
              id="contact-message"
              name="message"
              placeholder="Tell me about your PC and what you'd like to optimize..."
              rows="5"
              required
              maxLength={5000}
              className={INPUT_CLASS}
              {...fieldProps("message")}
            ></textarea>
            <FieldError id="contact-message-error" message={submission.fields.message} />
          </div>
          <div className="sr-only" aria-hidden="true">
            <label htmlFor="contact-company">Company</label>
            <input type="text" id="contact-company" name="company" tabIndex={-1} autoComplete="off" />
          </div>

          {submission.state === "failed" ? (
            <p role="alert" className="text-sm text-danger-text">
              {submission.error === "limited"
                ? "Too many messages right now. Please try again later, or email "
                : "Your message didn't send. Please try again, or email "}
              {contactEmail} directly.
            </p>
          ) : null}

          <button
            type="submit"
            disabled={sending}
            aria-busy={sending}
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
            {contactEmail}
          </p>
        </form>
      )}

      <div className="h-3" />
      <div className="w-full max-w-xl text-sm text-ink-secondary leading-relaxed">
        {CONTACT_GUIDANCE.map((paragraph) => (
          <p key={paragraph} className="mt-4">{paragraph}</p>
        ))}
      </div>

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
