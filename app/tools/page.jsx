import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/tools");

export default function Page({ searchParams }) {
  return (
    <div style={{ minHeight: "700px" }}>
      <RouteRenderer pathname="/tools" searchParams={searchParams} />
    </div>
  );
}
