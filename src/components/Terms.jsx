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
                    link: ({ value, children }) => (
                      <a
                        href={value?.href}
                        className="underline text-white hover:text-cyan-400 transition-colors"
                        target={
                          value?.href?.startsWith("http") ? "_blank" : undefined
                        }
                        rel={
                          value?.href?.startsWith("http")
                            ? "noopener noreferrer"
                            : undefined
                        }
                      >
                        {children}
                      </a>
                    ),
                  },
                  block: {
                    normal: ({ children }) => (
                      <p className="text-white">{children}</p>
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
