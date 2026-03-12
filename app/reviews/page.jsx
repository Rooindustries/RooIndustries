import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { getReviewsPageData } from "@/src/lib/sanityPageData";

export const metadata = seo.getMetadataForPath("/reviews");
export const revalidate = 60;

export default async function Page() {
  const reviewsPageData = await getReviewsPageData();

  return (
    <RouteRenderer
      pathname="/reviews"
      initialRouteData={{ reviews: reviewsPageData }}
    />
  );
}
