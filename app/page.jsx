import RouteRenderer from "@/src/next/RouteRenderer";
import JsonLd from "@/src/next/JsonLd";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/");

export default function Page({ searchParams }) {
  return (
    <>
      <JsonLd data={seo.buildOrganizationJsonLd()} />
      <JsonLd data={seo.buildOfferCatalogJsonLd()} />
      <RouteRenderer pathname="/" searchParams={searchParams} />
    </>
  );
}
