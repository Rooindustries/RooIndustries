import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/404");

export default function NotFound() {
  return <RouteRenderer pathname="/__missing__" searchParams={{}} />;
}
