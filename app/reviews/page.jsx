import Reviews from "@/src/next/entries/Reviews";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { fetchPublicContent } from "@/src/server/content/publicContent";
import { logSafeError } from "@/src/server/safeErrorLog";

export const metadata = seo.getMetadataForPath("/reviews");
export const dynamic = "force-dynamic";

export default async function Page() {
  let reviewsGallery = null;
  try {
    reviewsGallery = await fetchPublicContent({ resource: "reviews-gallery", searchParams: new URLSearchParams() });
  } catch (error) {
    logSafeError("Reviews page content unavailable", error);
  }
  return <RouteRenderer entry={Reviews} pathname="/reviews" searchParams={{}} initialRouteData={{ reviewsGallery }} />;
}
