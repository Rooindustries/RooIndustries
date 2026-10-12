import Terms from "@/src/next/entries/Terms";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/terms");

export default function Page({ searchParams }) {
  return <RouteRenderer entry={Terms} pathname="/terms" searchParams={searchParams} />;
}
