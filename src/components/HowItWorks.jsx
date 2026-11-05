import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarCheck, ClipboardCheck, Cpu, Gauge } from "lucide-react";
import homeCopy from "../lib/homeCopy";
import { fetchHomeSectionData, HOME_SECTION_DATA_KEYS, readHomeSectionData } from "../lib/homeSectionData";
import useHomeSectionLinkHandler from "../lib/useHomeSectionLinkHandler";

const { HOME_COPY } = homeCopy;
const fallbackData = HOME_COPY.howItWorks;
const STEP_ICONS = [CalendarCheck, ClipboardCheck, Cpu, Gauge];

export default function HowItWorks({ initialData = null }) {
  const [data, setData] = useState(
    () => initialData ?? fallbackData
  );
  const handleHomeSectionLink = useHomeSectionLinkHandler();

  useEffect(() => {
    if (initialData !== null) {
      setData(initialData);
    }
  }, [initialData]);

  useEffect(() => {
    if (initialData !== null) return;
    const cachedData = readHomeSectionData(HOME_SECTION_DATA_KEYS.howItWorks);
    if (cachedData !== null) {
      setData(cachedData);
      return;
    }
    fetchHomeSectionData(HOME_SECTION_DATA_KEYS.howItWorks)
      .then((res) => { if (res) setData(res); })
      .catch((err) => console.error("CMS fetch error:", err));
  }, [initialData]);

  return (
    <section className="ri-hiw-section relative z-10 py-12 sm:py-16 px-4 sm:px-6 text-ink max-w-[80rem] mx-auto">
      {data.title && (
        <h2 className="section-title text-center">
          {data.title}
        </h2>
      )}

      {data.subtitle && (
        <p className="section-lede text-center">
          {data.subtitle}
        </p>
      )}

      {data.steps?.length > 0 && (
        <ol className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
          {data.steps.map((s, i) => {
            const Icon = STEP_ICONS[i % STEP_ICONS.length];
            return (
              <li
                key={i}
                className="ri-hiw-card rounded-2xl border border-line-soft bg-surface-card p-6"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-surface-hover">
                    <Icon className="ri-service-icon h-6 w-6 text-accent" aria-hidden="true" />
                  </span>
                  {s.badge && (
                    <span className="text-sm font-semibold text-ink-secondary">
                      {s.badge}
                    </span>
                  )}
                </div>

                {s.title && (
                  <h3 className="ri-hiw-step-title mt-6 text-xl font-bold tracking-tight text-ink">
                    {s.title}
                  </h3>
                )}

                {s.text && (
                  <p className="ri-hiw-step-copy mt-2 text-ink-secondary leading-relaxed">
                    {s.text}
                    {s.title?.toLowerCase().includes("install") && (
                      <span className="ri-hiw-trust-copy text-ink-muted font-medium">
                        {" "}
                        (
                        <Link
                          to="/#trust"
                          onClick={(event) =>
                            handleHomeSectionLink(event, "#trust")
                          }
                          className="ri-hiw-trust-link text-accent font-semibold transition-colors duration-300 hover:text-[color:var(--color-link-hover)]"
                        >
                          Read How can I trust you? Is this secure?
                        </Link>
                        )
                      </span>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
