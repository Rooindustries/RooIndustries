import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { fetchPublicContent } from "@/src/server/content/publicContent";

export const metadata = seo.getMetadataForPath("/reviews");
export const dynamic = "force-dynamic";

export default async function Page() {
  const reviewsGallery = await fetchPublicContent({ resource: "reviews-gallery", searchParams: new URLSearchParams() });
  return <RouteRenderer pathname="/reviews" searchParams={{}} initialRouteData={{ reviewsGallery }} />;
}
