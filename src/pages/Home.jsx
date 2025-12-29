import Hero from "../components/Hero";
import About from "../components/About";
import Services from "../components/Services";
import StreamerYoutuberReviews from "../components/StreamerYoutuberReviews";
import Footer from "../components/Footer";
import HowItWorks from "../components/HowItWorks";
import ReferralBox from "../components/ReferralBox";
import Packages from "../components/Packages";
import SupportedGames from "../components/SupportedGames";
import Faq from "../components/Faq";
import SEO from "../components/SEO";
import { Link } from "react-router-dom";
import {
  buildOfferCatalogJsonLd,
  buildOrganizationJsonLd,
  DEFAULT_DESCRIPTION,
  DEFAULT_TITLE,
} from "../seoConfig";

export default function Home() {
  return (
    <>
      <SEO
        title={DEFAULT_TITLE}
        description={DEFAULT_DESCRIPTION}
        jsonLd={[buildOrganizationJsonLd(), buildOfferCatalogJsonLd()]}
      />
      <Hero />
      <StreamerYoutuberReviews />
      <Services />
      <Packages />
      <HowItWorks />
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
      <About />
      <SupportedGames />
      <Faq compact />
      <ReferralBox />
      <Footer />
    </>
  );
}
