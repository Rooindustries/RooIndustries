import React, { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { client, urlFor } from "../sanityClient";

export default function About() {
  const [aboutData, setAboutData] = useState(null);

  useEffect(() => {
    client
      .fetch(
        `*[_type == "about"][0]{
          title,
          description,
          recordTitle,
          recordImage,
          recordLink
        }`
      )
      .then(setAboutData)
      .catch(console.error);
  }, []);

  const recordImageUrl = aboutData?.recordImage
    ? urlFor(aboutData.recordImage).url()
    : null;

  return (
    <section
      id="about"
      className="mx-auto max-w-5xl pt-24 text-center px-6 sm:px-0"
    >
      <h2 className="text-5xl sm:text-6xl font-extrabold tracking-tight text-white">
        {aboutData?.title || "About Roo Industries"}
      </h2>

      <div className="mx-auto mt-8 max-w-3xl rounded-lg bg-[#1b2430] p-8 ring-1 ring-[#2b3a4a] text-left text-[15px] leading-7 text-slate-200/90 min-h-[120px] flex items-center">
        <p>
          {aboutData?.description ||
            "Roo Industries pushes PCs to their absolute limit with safe, professional tuning, benchmark-proven results, and real-world gaming improvements."}
        </p>
      </div>

      <div className="mt-12 flex flex-col items-center">
        <div className="flex items-center gap-2 mb-3 min-h-[32px]">
          <Zap className="text-cyan-500 w-5 h-5 animate-pulse drop-shadow-[0_0_6px_#00ffff]" />
          <h3 className="text-cyan-400 font-semibold text-lg sm:text-xl tracking-wide drop-shadow-[0_0_8px_#00ffff]">
            {aboutData?.recordTitle || "World-Class Benchmark Results"}
          </h3>
          <Zap className="text-cyan-500 w-5 h-5 animate-pulse drop-shadow-[0_0_6px_#00ffff]" />
        </div>

        {recordImageUrl ? (
          <a
            href={aboutData?.recordLink || "#"}
            target="_blank"
            rel="noreferrer"
            className="block w-full max-w-4xl"
            style={{ aspectRatio: "16 / 9" }}
          >
            <img
              src={recordImageUrl}
              alt="System Benchmark Result"
              loading="lazy"
              className="w-full h-full rounded-lg shadow-lg border border-[#2b3a4a] hover:border-cyan-500 transition-all duration-300 object-cover"
            />
          </a>
        ) : (
          <div
            className="w-full max-w-4xl rounded-lg shadow-lg border border-[#2b3a4a] bg-[#111827] transition-all duration-300"
            style={{ aspectRatio: "16 / 9" }}
          />
        )}
      </div>

      <div className="h-3" />
    </section>
  );
}
