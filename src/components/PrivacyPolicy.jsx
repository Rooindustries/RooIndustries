import React, { useEffect, useState } from "react";
import { PortableText } from "@portabletext/react";
import { client } from "../sanityClient";

export default function PrivacyPolicy() {
  const [data, setData] = useState(null);

  // Helper function to process text strings within paragraphs, converting the specific email to a link
  const renderTextWithLinks = (text) => {
    if (typeof text !== "string") return text;

    // 1. Clean up markdown artifacts like [email](mailto:...) -> email
    // This addresses the issue where the link is displayed twice due to bad formatting in Sanity.
    let cleanText = text.replace(
      /\[(serviroo@rooindustries\.com)\]\(.*?\)/gi,
      "$1"
    );

    // 2. Split text to isolate the email
    const parts = cleanText.split(/(serviroo@rooindustries\.com)/gi);

    return parts.map((part, i) => {
      // 3. If this part is the email, apply the mailto link and style
      if (part.toLowerCase() === "serviroo@rooindustries.com") {
        return (
          <a
            key={i}
            href="mailto:serviroo@rooindustries.com"
            // Applied the requested cyan styling
            className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2 transition-colors"
          >
            {part}
          </a>
        );
      }
      return part;
    });
  };

  // Fetch from Sanity
  useEffect(() => {
    client
      .fetch(
        `*[_type == "privacyPolicy"][0]{
          title,
          sections[]{heading, content},
          lastUpdated
        }`
      )
      .then(setData)
      .catch(console.error);
  }, []);

  if (!data) return null;

  return (
    <div className="py-20 max-w-3xl mx-auto p-6 text-white">
      {/* Title */}
      {data.title && <h1 className="text-3xl font-bold mb-6">{data.title}</h1>}

      {/* Render Sections */}
      {data.sections?.map((section, i) => (
        <div key={i} className="mb-8">
          {section.heading && (
            <h2 className="text-2xl font-semibold mt-6 mb-2 text-white">
              {section.heading}
            </h2>
          )}
          {section.content && (
            <PortableText
              value={section.content}
              components={{
                marks: {
                  link: ({ value, children }) => {
                    const href = (value?.href || "").toLowerCase();
                    const isContactLink =
                      href === "/contact" ||
                      href.startsWith("/contact?") ||
                      href.startsWith("/contact#") ||
                      href.startsWith("/contact/");
                    const isTargetEmail =
                      href.includes("rooindustries.com") ||
                      href.startsWith("mailto") ||
                      isContactLink;

                    const finalHref = isTargetEmail
                      ? "mailto:serviroo@rooindustries.com"
                      : value?.href;
                    const linkClasses = isTargetEmail
                      ? "text-cyan-400 hover:text-cyan-300 underline underline-offset-2 transition-colors"
                      : "underline hover:text-cyan-400 transition-colors text-slate-200";

                    const target = finalHref?.startsWith("http")
                      ? "_blank"
                      : undefined;

                    return (
                      <a
                        href={finalHref}
                        target={target}
                        rel={
                          target === "_blank"
                            ? "noopener noreferrer"
                            : undefined
                        }
                        className={linkClasses}
                      >
                        {children}
                      </a>
                    );
                  },
                },
                block: {
                  normal: ({ children }) => (
                    <p className="mb-4 leading-relaxed text-slate-200">
                      {/* Use the helper function here to process plain text children */}
                      {React.Children.map(children, (child) =>
                        renderTextWithLinks(child)
                      )}
                    </p>
                  ),
                },
                list: {
                  bullet: ({ children }) => (
                    <ul className="list-disc list-inside mb-4 text-slate-200">
                      {children}
                    </ul>
                  ),
                },
              }}
            />
          )}
        </div>
      ))}

      {/* Last updated */}
      {data.lastUpdated && (
        <p className="mt-8 text-sm text-slate-400">
          Last updated: {data.lastUpdated}
        </p>
      )}
    </div>
  );
}
