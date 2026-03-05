import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/reviews");

export default function Page({ searchParams }) {
  return <RouteRenderer pathname="/reviews" searchParams={searchParams} />;
}
