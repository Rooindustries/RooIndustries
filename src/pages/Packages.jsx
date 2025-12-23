import Footer from "../components/Footer";
import PackagesComp from "../components/Packages";
import SEO from "../components/SEO";
import { buildOfferCatalogJsonLd } from "../seoConfig";
export default function Packages() {
  return (
    <>
      <SEO
        title="PC Optimization Packages | Roo Industries"
        description="Choose the tuning package that best fits your system and performance goals."
        jsonLd={buildOfferCatalogJsonLd("Tuning Packages")}
      />
      <PackagesComp />
      <Footer />
    </>
  );
}
