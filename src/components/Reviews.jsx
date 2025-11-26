import React, { useState, useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { client } from "../sanityClient";

export default function Reviews() {
  const [data, setData] = useState(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  const containerRef = useRef(null);

  useEffect(() => {
    const query = `*[_type == "reviewsCarousel"][0]{
      title,
      subtitle,
      reviews[]{ name, text }
    }`;

    let cancelled = false;

    const fetchData = async () => {
      const res = await client.fetch(query);
      if (!cancelled) setData(res);
    };

    fetchData();

    // Live sanity listener
    const subscription = client
      .listen(query, {}, { visibility: "query" })
      .subscribe((update) => {
        if (cancelled) return;
        if (update.result) setData(update.result);
        else setData(null);
      });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  const handleNext = () => {
    if (!data?.reviews?.length) return;
    setIndex((prev) => (prev + 1) % data.reviews.length);
  };

  const handlePrev = () => {
    if (!data?.reviews?.length) return;
    setIndex((prev) => (prev - 1 + data.reviews.length) % data.reviews.length);
  };

  // Auto slide — stabilized interval
  useEffect(() => {
    if (paused || !data?.reviews?.length) return;
    const interval = setInterval(handleNext, 2000);
    return () => clearInterval(interval);
  }, [paused, data]);

  const fixedHeight = "380px";

  return (
    <section className="py-32 text-center text-white relative overflow-hidden">
      <h2 className="text-4xl font-extrabold mb-3 drop-shadow-[0_0_15px_rgba(56,189,248,0.4)]">
        {data?.title || "What People Say"}
      </h2>

      <p className="text-slate-200 mb-12">
        {data?.subtitle ||
          "Feedback from clients I’ve had the pleasure of helping."}
      </p>

      <div
        className="relative mx-auto max-w-[900px] overflow-hidden rounded-3xl"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        ref={containerRef}
        style={{ height: fixedHeight }}
      >
        <div
          className="flex transition-transform duration-700 ease-in-out"
          style={{ transform: `translateX(-${index * 100}%)` }}
        >
          {(data?.reviews || []).map((review, i) => (
            <div
              key={i}
              className="flex-shrink-0 w-full h-[380px] sm:h-[220px] md:h-[240px]
                         flex flex-col items-center 
                         bg-[#0b1120]/90 rounded-3xl 
                         shadow-[0_0_25px_rgba(14,165,233,0.25)] 
                         border border-sky-700/30 px-10 py-10 relative"
            >
              <h3 className="text-3xl font-semibold text-sky-300 mb-6 absolute top-8">
                {review.name}
              </h3>

              <div className="flex-grow flex items-center justify-center mt-6">
                <p className="text-slate-100 text-lg sm:text-xl leading-relaxed max-w-2xl">
                  {review.text}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Navigation Buttons */}
        <button
          onClick={handlePrev}
          className="absolute left-6 top-1/2 -translate-y-1/2 
                     bg-slate-900/80 hover:bg-slate-800 
                     border border-sky-600/40 
                     p-3 rounded-full shadow-md 
                     transition z-10"
        >
          <ChevronLeft className="w-6 h-6 text-cyan-300" />
        </button>

        <button
          onClick={handleNext}
          className="absolute right-6 top-1/2 -translate-y-1/2 
                     bg-slate-900/80 hover:bg-slate-800 
                     border border-sky-600/40 
                     p-3 rounded-full shadow-md 
                     transition z-10"
        >
          <ChevronRight className="w-6 h-6 text-cyan-300" />
        </button>
      </div>
    </section>
  );
}
