import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/reviews");
export const dynamic = "force-static";

export default function Page() {
  return <RouteRenderer pathname="/reviews" searchParams={{}} />;
}
