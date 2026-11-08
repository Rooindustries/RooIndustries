import React from "react";
import { PortableText } from "@portabletext/react";
import { useContent } from "../lib/useContent";
import { normalizePolicyLink } from "../lib/policyLinks";
import contactEmail from "../lib/contactEmail";

const { CONTACT_EMAIL } = contactEmail;
const ESCAPED_EMAIL = CONTACT_EMAIL.replace(/[.]/g, "\\.");
const EMAIL_PATTERN = new RegExp(`(${ESCAPED_EMAIL})`, "gi");
const MARKDOWN_EMAIL_PATTERN = new RegExp(`\\[(${ESCAPED_EMAIL})\\]\\(.*?\\)`, "gi");
const OUTSIDE_LINK = /^(https?:)?\/\/(?!(www\.)?rooindustries\.com([/:?#]|$))/i;
const emailLinkClass = "text-accent underline underline-offset-2 transition-colors hover:text-[color:var(--color-link-hover)]";
const textLinkClass = "text-ink underline underline-offset-2 transition-colors hover:text-[color:var(--color-link-hover)]";

const renderTextWithLinks = (text) => {
  if (typeof text !== "string") return text;
  return text
    .replace(MARKDOWN_EMAIL_PATTERN, "$1")
    .split(EMAIL_PATTERN)
    .map((part, index) =>
      part.toLowerCase() === CONTACT_EMAIL ? (
        <a key={index} href={`mailto:${CONTACT_EMAIL}`} className={emailLinkClass}>
          {part}
        </a>
      ) : (
        part
      )
    );
};

const PolicyLink = ({ value, children }) => {
  const href = normalizePolicyLink(value?.href);
  const isEmail = href.toLowerCase().startsWith("mailto:");
  const opensNewTab = OUTSIDE_LINK.test(href);
  return (
    <a
      href={href}
      target={opensNewTab ? "_blank" : undefined}
      rel={opensNewTab ? "noopener noreferrer" : undefined}
      className={isEmail ? emailLinkClass : textLinkClass}
    >
      {children}
    </a>
  );
};

const portableComponents = {
  marks: { link: PolicyLink },
  block: {
    normal: ({ children }) => <p>{React.Children.map(children, renderTextWithLinks)}</p>,
  },
  list: {
    bullet: ({ children }) => <ul className="list-disc space-y-2 pl-5 marker:text-ink-muted">{children}</ul>,
    number: ({ children }) => <ol className="list-decimal space-y-2 pl-5 marker:text-ink-muted">{children}</ol>,
  },
};

export default function PolicyDocument({ data }) {
  const sections = data.sections || [];

  return (
    <article className="page-top mx-auto max-w-6xl px-5 pb-24 text-ink sm:px-6">
      <div className="mx-auto max-w-[68ch]">
        <header>
          {data.title && <h1 className="section-title">{data.title}</h1>}
          {data.lastUpdated && (
            <p className="mt-3 text-sm text-ink-muted">Last updated: {data.lastUpdated}</p>
          )}
        </header>

        <div className="mt-10 space-y-10">
          {sections.map((section, index) => (
            <section key={section._key || index}>
              {section.heading && (
                <h2 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">
                  {section.heading}
                </h2>
              )}
              {section.content && (
                <div className="mt-3 space-y-4 break-words text-base leading-relaxed text-ink-secondary">
                  <PortableText value={section.content} components={portableComponents} />
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </article>
  );
}

export function PolicyPage({ contentKey, initialData = null }) {
  const { data } = useContent(contentKey, initialData);

  if (!data) return null;

  return <PolicyDocument data={data} />;
}
