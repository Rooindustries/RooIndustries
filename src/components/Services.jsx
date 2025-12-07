import React, { useEffect, useState } from "react";
import { client } from "../sanityClient";
import { Clock, Shield, Wrench, Zap, Video, Cpu } from "lucide-react";

export default function Services() {
  const [data, setData] = useState(null);

  useEffect(() => {
    client
      .fetch(
        `*[_type == "services"][0]{
          heading,
          subheading,
          cards[]{title, description, iconType}
        }`
      )
      .then(setData)
      .catch(console.error);
  }, []);

  if (!data) return null;

  const icons = {
    zap: (
      <Zap className="w-5 h-5 text-cyan-400 drop-shadow-[0_0_8px_rgba(14,165,233,0.7)]" />
    ),
    clock: (
      <Clock className="w-5 h-5 text-cyan-400 drop-shadow-[0_0_8px_rgba(14,165,233,0.7)]" />
    ),
    shield: (
      <Shield className="w-5 h-5 text-cyan-400 drop-shadow-[0_0_8px_rgba(14,165,233,0.7)]" />
    ),
    wrench: (
      <Wrench className="w-5 h-5 text-cyan-400 drop-shadow-[0_0_8px_rgba(14,165,233,0.7)]" />
    ),
    video: (
      <Video className="w-6 h-6 text-cyan-400 drop-shadow-[0_0_8px_rgba(14,165,233,0.7)]" />
    ),
    cpu: (
      <Cpu className="w-6 h-6 text-cyan-400 drop-shadow-[0_0_8px_rgba(14,165,233,0.7)]" />
    ),
  };

  return (
    <section className="mx-auto max-w-6xl py-24 px-4 sm:px-6">
      {/* Heading */}
      <div className="text-center">
        {data.heading && (
          <h3 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
            {data.heading}
          </h3>
        )}
        {data.subheading && (
          <p className="mt-2 text-slate-200 text-sm">{data.subheading}</p>
        )}
      </div>

      <div className="h-10" />

      {/* Services Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {data.cards?.map((card, i) => (
          <div
            key={i}
            className="rounded-md bg-[#121821] ring-1 ring-[#2b3a4a] p-6 text-center hover:ring-[#19c5ff]/60 transition"
          >
            <div className="mb-3 flex justify-center">
              {icons[card.iconType] || null}
            </div>
            <h4 className="text-[15px] font-bold tracking-tight">
              {card.title}
            </h4>
            <p className="mt-2 text-[12px] leading-5 text-slate-200/90">
              {card.description}
            </p>
            <div className="mt-5 border-t border-[#2b3a4a]" />
          </div>
        ))}
      </div>

      <div className="h-3" />
    </section>
  );
}
