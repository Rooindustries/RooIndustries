import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/benchmarks");
export const dynamic = "force-static";

export default function Page() {
  return <RouteRenderer pathname="/benchmarks" searchParams={{}} />;
}
