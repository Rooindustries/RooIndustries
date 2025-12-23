import Hero from "../components/Hero";
import About from "../components/About";
import Services from "../components/Services";
import StreamerYoutuberReviews from "../components/StreamerYoutuberReviews";
import Footer from "../components/Footer";
import HowItWorks from "../components/HowItWorks";
import ReferralBox from "../components/ReferralBox";
import Packages from "../components/Packages";
import Faq from "../components/Faq";
import SEO from "../components/SEO";
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
      <About />
      <Faq />
      <ReferralBox />
      <Footer />
    </>
  );
}
