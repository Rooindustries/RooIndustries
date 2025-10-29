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

  if (!aboutData) return null;

  return (
    <section id="about" className="mx-auto max-w-5xl pt-24 text-center">
      <h2 className="text-5xl sm:text-6xl font-extrabold tracking-tight text-white">
        {aboutData.title}
      </h2>

      <div className="mx-auto mt-8 max-w-3xl rounded-lg bg-[#1b2430] p-8 ring-1 ring-[#2b3a4a] text-left text-[15px] leading-7 text-slate-200/90">
        {aboutData.description}
      </div>

      {/* Leaderboard section */}
      <div className="mt-12 flex flex-col items-center">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="text-cyan-500 w-5 h-5 animate-pulse drop-shadow-[0_0_6px_#00ffff]" />
          <h3 className="text-cyan-400 font-semibold text-lg sm:text-xl tracking-wide drop-shadow-[0_0_8px_#00ffff]">
            {aboutData.recordTitle}
          </h3>
          <Zap className="text-cyan-500 w-5 h-5 animate-pulse drop-shadow-[0_0_6px_#00ffff]" />
        </div>

        <a href={aboutData.recordLink} target="_blank" rel="noreferrer">
          <img
            src={urlFor(aboutData.recordImage).url()}
            alt="System Benchmark Result"
            className="rounded-lg shadow-lg border border-[#2b3a4a] hover:border-cyan-500 transition-all duration-300"
          />
        </a>
      </div>

      <div className="h-3" />
    </section>
  );
}
