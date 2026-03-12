import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/contact");

export default function Page({ searchParams }) {
  return <RouteRenderer pathname="/contact" searchParams={searchParams} />;
}
