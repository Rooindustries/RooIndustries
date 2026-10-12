import UpgradeXoc from "@/src/next/entries/UpgradeXoc";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/upgrade-xoc");

export default function Page({ searchParams }) {
  return (
    <>
      <h1 className="sr-only">Upgrade to Performance Vertex Max</h1>
      <RouteRenderer entry={UpgradeXoc} pathname="/upgrade-xoc" searchParams={searchParams} />
    </>
  );
}
