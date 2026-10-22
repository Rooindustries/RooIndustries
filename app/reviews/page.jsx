import Reviews from "@/src/next/entries/Reviews";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/reviews");
export const dynamic = "force-static";
export const revalidate = 60;

export default async function Page() {
  const reviewsGallery = await contentServer.fetchReviewsGallery({
    requireContent: process.env.NEXT_PHASE !== "phase-production-build",
  });
  return <RouteRenderer entry={Reviews} pathname="/reviews" searchParams={{}} initialRouteData={{ reviewsGallery }} />;
}
