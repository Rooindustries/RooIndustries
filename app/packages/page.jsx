import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/packages");

export default function Page({ searchParams }) {
  return (
    <>
      <h1 className="sr-only">PC Optimization Packages</h1>
      <RouteRenderer pathname="/packages" searchParams={searchParams} />
    </>
  );
}
