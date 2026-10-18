import Benchmarks from "@/src/next/entries/Benchmarks";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/benchmarks");
export const dynamic = "force-static";
export const revalidate = 60;

export default async function Page() {
  const benchmarks = await contentServer.fetchBenchmarks({
    requireContent: process.env.NEXT_PHASE !== "phase-production-build",
  });
  return <RouteRenderer entry={Benchmarks} pathname="/benchmarks" searchParams={{}} initialRouteData={{ benchmarks }} />;
}
