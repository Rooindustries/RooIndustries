import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/upgrade-xoc");

export default function Page({ searchParams }) {
  return (
    <>
      <h1 className="sr-only">Upgrade to XOC</h1>
      <RouteRenderer pathname="/upgrade-xoc" searchParams={searchParams} />
    </>
  );
}
