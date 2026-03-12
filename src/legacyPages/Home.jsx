import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import Hero from "../components/Hero";
import { Link, useLocation } from "react-router-dom";
import {
  isHomeSectionHash,
  normalizeSectionHash,
  readPendingSectionTarget,
} from "../lib/sectionNavigation";
import { useLowPerformanceMode } from "../lib/performanceMode";
import About from "../components/About";
import StreamerYoutuberReviews from "../components/StreamerYoutuberReviews";
import Footer from "../components/Footer";
import HowItWorks from "../components/HowItWorks";
import ReferralBox from "../components/ReferralBox";
import SupportedGames from "../components/SupportedGames";

// Lazy-load framer-motion-heavy sections to keep them out of the initial bundle.
// DeferredSection already defers rendering until near-viewport; lazy() defers
// the JS download/parse too — saving ~52 KB (gzipped) from first-load.
const Services = lazy(() => import("../components/Services"));
const Packages = lazy(() => import("../components/Packages"));
const Faq = lazy(() => import("../components/Faq"));

function DeferredSection({
  children,
  fallbackClassName,
  rootMargin = "240px 0px",
  eager = false,
}) {
  const ref = useRef(null);
  const [isVisible, setIsVisible] = useState(eager);

  useEffect(() => {
    if (isVisible) return;
    if (typeof IntersectionObserver === "undefined" || !ref.current) {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin }
    );

    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [isVisible, rootMargin]);

  return (
    <div ref={ref}>
      {isVisible ? (
        children
      ) : (
        <div aria-hidden="true" className={fallbackClassName} />
      )}
    </div>
  );
}

export default function Home({ initialData = null }) {
  const location = useLocation();
  const isLowPerf = useLowPerformanceMode();
  const [forceEagerSections, setForceEagerSections] = useState(() =>
    isHomeSectionHash(normalizeSectionHash(location.hash || "")) ||
    isHomeSectionHash(readPendingSectionTarget())
  );
  // In low-perf mode, render all sections eagerly — CSS content-visibility: auto
  // handles lazy painting. This avoids 250-471ms React render burst stalls.
  const eagerAll = forceEagerSections || isLowPerf;

  useEffect(() => {
    const hasSectionIntent = isHomeSectionHash(
      normalizeSectionHash(location.hash || "")
    );
    const hasPendingSectionIntent = isHomeSectionHash(readPendingSectionTarget());
    if (hasSectionIntent || hasPendingSectionIntent) {
      setForceEagerSections(true);
    }
  }, [location.hash]);

  return (
    <>
      <Hero />
      <DeferredSection
        fallbackClassName="min-h-[380px]"
        rootMargin="160px 0px"
        eager={eagerAll}
      >
        <StreamerYoutuberReviews initialData={initialData?.reviews || null} />
      </DeferredSection>
      <DeferredSection
        fallbackClassName="min-h-[260px]"
        rootMargin="160px 0px"
        eager={eagerAll}
      >
        <div className="deferred-section-content">
          <About initialData={initialData?.about || null} />
        </div>
      </DeferredSection>
      <section id="services" style={{ scrollMarginTop: "var(--section-nav-offset)" }}>
        <DeferredSection
          fallbackClassName="min-h-[520px]"
          rootMargin="240px 0px"
          eager={eagerAll}
        >
          <Suspense fallback={<div className="min-h-[520px]" />}>
            <div className="deferred-section-content">
              <Services initialData={initialData?.services || null} />
            </div>
          </Suspense>
        </DeferredSection>
      </section>
      <section id="packages" style={{ scrollMarginTop: "var(--section-nav-offset)" }}>
        <DeferredSection
          fallbackClassName="min-h-[620px]"
          rootMargin="300px 0px"
          eager={eagerAll}
        >
          <Suspense fallback={<div className="min-h-[620px]" />}>
            <div className="deferred-section-content">
              <Packages
                initialPackages={initialData?.packagesList || null}
                initialSectionCopy={initialData?.packagesSettings || null}
              />
            </div>
          </Suspense>
        </DeferredSection>
      </section>
      <section id="how-it-works">
        <DeferredSection
          fallbackClassName="min-h-[340px]"
          rootMargin="220px 0px"
          eager={eagerAll}
        >
          <div className="deferred-section-content">
            <HowItWorks initialData={initialData?.howItWorks || null} />
          </div>
        </DeferredSection>
      </section>
      <div className="mt-4 flex items-center justify-center">
        <Link
          to="/#packages"
          className="glow-button book-optimization-button relative inline-flex items-center justify-center gap-2 rounded-md px-4 sm:px-6 py-2.5 sm:py-3.5 text-sm sm:text-base font-semibold text-white ring-2 ring-cyan-300/70 hover:text-white active:translate-y-px transition-all duration-300"
        >
          Tune My Rig
          <span className="glow-line glow-line-top" />
          <span className="glow-line glow-line-right" />
          <span className="glow-line glow-line-bottom" />
          <span className="glow-line glow-line-left" />
        </Link>
      </div>
      <DeferredSection
        fallbackClassName="min-h-[360px]"
        rootMargin="220px 0px"
        eager={eagerAll}
      >
        <div className="deferred-section-content">
          <SupportedGames initialData={initialData?.supportedGames || null} />
        </div>
      </DeferredSection>
      <section id="faq" style={{ scrollMarginTop: "var(--section-nav-offset)" }}>
        <DeferredSection
          fallbackClassName="min-h-[380px]"
          rootMargin="220px 0px"
          eager={eagerAll}
        >
          <Suspense fallback={<div className="min-h-[380px]" />}>
            <div className="deferred-section-content">
              <Faq
                compact
                initialFaqCopy={initialData?.faqSettings || null}
                initialQuestions={initialData?.faqQuestions || null}
              />
            </div>
          </Suspense>
        </DeferredSection>
      </section>
      <DeferredSection
        fallbackClassName="min-h-[160px]"
        rootMargin="220px 0px"
        eager={eagerAll}
      >
        <div className="deferred-section-content">
          <ReferralBox />
        </div>
      </DeferredSection>
      <Footer />
    </>
  );
}
