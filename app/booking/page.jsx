import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/booking");

export default function Page({ searchParams }) {
  return <RouteRenderer pathname="/booking" searchParams={searchParams} />;
}
