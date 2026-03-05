import React, { Suspense, lazy, useEffect, useRef, useState } from "react";
import Hero from "../components/Hero";
import { Link } from "react-router-dom";

const About = lazy(() => import("../components/About"));
const Services = lazy(() => import("../components/Services"));
const StreamerYoutuberReviews = lazy(() =>
  import("../components/StreamerYoutuberReviews")
);
const Footer = lazy(() => import("../components/Footer"));
const HowItWorks = lazy(() => import("../components/HowItWorks"));
const ReferralBox = lazy(() => import("../components/ReferralBox"));
const Packages = lazy(() => import("../components/Packages"));
const SupportedGames = lazy(() => import("../components/SupportedGames"));
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

const SectionFallback = ({ className }) => (
  <div aria-hidden="true" className={className} />
);

export default function Home() {
  return (
    <>
      <Hero />
      <DeferredSection fallbackClassName="min-h-[380px]" rootMargin="260px 0px">
        <Suspense fallback={<SectionFallback className="min-h-[380px]" />}>
          <StreamerYoutuberReviews />
        </Suspense>
      </DeferredSection>
      <DeferredSection fallbackClassName="min-h-[260px]" rootMargin="280px 0px">
        <Suspense fallback={<SectionFallback className="min-h-[260px]" />}>
          <About />
        </Suspense>
      </DeferredSection>
      <section id="services">
        <DeferredSection
          fallbackClassName="min-h-[520px]"
          rootMargin="420px 0px"
        >
          <Suspense fallback={<SectionFallback className="min-h-[520px]" />}>
            <Services />
          </Suspense>
        </DeferredSection>
      </section>
      <section id="packages">
        <DeferredSection
          fallbackClassName="min-h-[620px]"
          rootMargin="520px 0px"
        >
          <Suspense fallback={<SectionFallback className="min-h-[620px]" />}>
            <Packages />
          </Suspense>
        </DeferredSection>
      </section>
      <section id="how-it-works">
        <DeferredSection
          fallbackClassName="min-h-[340px]"
          rootMargin="360px 0px"
        >
          <Suspense fallback={<SectionFallback className="min-h-[340px]" />}>
            <HowItWorks />
          </Suspense>
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
      <DeferredSection fallbackClassName="min-h-[360px]" rootMargin="360px 0px">
        <Suspense fallback={<SectionFallback className="min-h-[360px]" />}>
          <SupportedGames />
        </Suspense>
      </DeferredSection>
      <DeferredSection fallbackClassName="min-h-[380px]" rootMargin="360px 0px">
        <Suspense fallback={<SectionFallback className="min-h-[380px]" />}>
          <Faq compact />
        </Suspense>
      </DeferredSection>
      <DeferredSection fallbackClassName="min-h-[160px]" rootMargin="320px 0px">
        <Suspense fallback={<SectionFallback className="min-h-[160px]" />}>
          <ReferralBox />
        </Suspense>
      </DeferredSection>
      <Suspense fallback={<SectionFallback className="min-h-[220px]" />}>
        <Footer />
      </Suspense>
    </>
  );
}
