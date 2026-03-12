import React, { useEffect, useState } from "react";
import { PortableText } from "@portabletext/react";
import { client } from "../sanityClient";

export default function Terms() {
  const [data, setData] = useState(null);

  useEffect(() => {
    client
      .fetch(
        `*[_type == "terms"][0]{
          title,
          lastUpdated,
          sections[]{heading, content}
        }`
      )
      .then(setData)
      .catch(console.error);
  }, []);

  // Helper: Manually processes text to find the email and apply the link + style
  const renderTextWithLinks = (text) => {
    if (typeof text !== "string") return text;

    // 1. Clean up markdown artifacts like [email](mailto:...) -> email
    let cleanText = text.replace(
      /\[(serviroo@rooindustries\.com)\]\(.*?\)/gi,
      "$1"
    );

    // 2. Split text to isolate the email
    const parts = cleanText.split(/(serviroo@rooindustries\.com)/gi);

    return parts.map((part, i) => {
      // 3. Apply the specific Cyan styling to the email part
      if (part.toLowerCase() === "serviroo@rooindustries.com") {
        return (
          <a
            key={i}
            href="mailto:serviroo@rooindustries.com"
            className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2 transition-colors"
          >
            {part}
          </a>
        );
      }
      return part;
    });
  };

  if (!data) return null;

  return (
    <section className="max-w-4xl mx-auto px-6 py-28 text-white">
      {/* Title */}
      {data.title && <h1 className="text-3xl font-bold mb-6">{data.title}</h1>}

      {/* Last updated */}
      {data.lastUpdated && (
        <p className="text-white mb-6">Last Updated: {data.lastUpdated}</p>
      )}

      <div className="space-y-6 text-white leading-relaxed">
        {data.sections?.map((sec, i) => (
          <div key={i}>
            {sec.heading && (
              <h2 className="text-xl font-semibold mt-6">{sec.heading}</h2>
            )}
            {sec.content && (
              <PortableText
                value={sec.content}
                components={{
                  marks: {
                    link: ({ value, children }) => {
                      const href = (value?.href || "").toLowerCase();
                      const isContactLink =
                        href === "/contact" ||
                        href.startsWith("/contact?") ||
                        href.startsWith("/contact#") ||
                        href.startsWith("/contact/");
                      const isEmail =
                        href.includes("rooindustries.com") ||
                        href.startsWith("mailto") ||
                        isContactLink;

                      const finalHref = isEmail
                        ? "mailto:serviroo@rooindustries.com"
                        : value?.href;

                      // Apply Cyan style if it's an email, otherwise keep standard white style
                      const linkClasses = isEmail
                        ? "text-cyan-400 hover:text-cyan-300 underline underline-offset-2 transition-colors"
                        : "underline text-white hover:text-cyan-400 transition-colors";

                      return (
                        <a
                          href={finalHref}
                          className={linkClasses}
                          target={!isEmail ? "_blank" : undefined}
                          rel={!isEmail ? "noopener noreferrer" : undefined}
                        >
                          {children}
                        </a>
                      );
                    },
                  },
                  block: {
                    normal: ({ children }) => (
                      <p className="text-white">
                        {/* Map over children to intercept the email string */}
                        {React.Children.map(children, (child) =>
                          renderTextWithLinks(child)
                        )}
                      </p>
                    ),
                  },
                }}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
