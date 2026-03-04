import MoreReviews from "../components/MoreReviews";
import Footer from "../components/Footer";
import SEO from "../components/SEO";
import { buildAggregateRatingJsonLd } from "../seoConfig";
export default function Reviews() {
  return (
    <>
      <SEO
        title="Client Reviews | Roo Industries"
        description="Read feedback from clients who upgraded their performance with Roo Industries."
        jsonLd={buildAggregateRatingJsonLd()}
      />
      <MoreReviews />
      <Footer />
    </>
  );
}
