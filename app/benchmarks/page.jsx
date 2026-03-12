import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { getBenchmarksPageData } from "@/src/lib/sanityPageData";

export const metadata = seo.getMetadataForPath("/benchmarks");
export const revalidate = 60;

export default async function Page() {
  const benchmarksPageData = await getBenchmarksPageData();

  return (
    <RouteRenderer
      pathname="/benchmarks"
      initialRouteData={{ benchmarks: benchmarksPageData }}
    />
  );
}
