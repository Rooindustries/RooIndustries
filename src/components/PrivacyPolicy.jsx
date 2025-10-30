import React, { useEffect, useState } from "react";
import { PortableText } from "@portabletext/react";
import { client } from "../sanityClient";

export default function PrivacyPolicy() {
  const [data, setData] = useState(null);

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
                // custom link, bullet list, and paragraph styles
                marks: {
                  link: ({ value, children }) => {
                    const target = value?.href?.startsWith("http")
                      ? "_blank"
                      : undefined;
                    return (
                      <a
                        href={value?.href}
                        target={target}
                        rel={
                          target === "_blank"
                            ? "noopener noreferrer"
                            : undefined
                        }
                        className="text-black underline hover:text-cyan-400 transition-colors"
                      >
                        {children}
                      </a>
                    );
                  },
                },
                block: {
                  normal: ({ children }) => (
                    <p className="mb-4 leading-relaxed text-slate-200">
                      {children}
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
