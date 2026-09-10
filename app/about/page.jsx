import RouteRenderer from "@/src/next/RouteRenderer";
import JsonLd from "@/src/next/JsonLd";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/about");

export default function Page({ searchParams }) {
  return (
    <>
      <JsonLd data={seo.buildOrganizationJsonLd()} />
      <RouteRenderer pathname="/about" searchParams={searchParams} />
    </>
  );
}
