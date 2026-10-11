import RouteRenderer from "@/src/next/RouteRenderer";
import JsonLd from "@/src/next/JsonLd";
import seo from "@/src/lib/seo";
import { applyHomeSectionCopyOverride } from "@/src/lib/homeCopy";
import { fetchPublicContent } from "@/src/server/content/publicContent";

export const metadata = seo.getMetadataForPath("/packages");

export default async function Page({ searchParams }) {
  const [packagesList, packagesSettings] = await Promise.all(
    ["packages-list", "packages-settings"].map(resource =>
      fetchPublicContent({ resource, searchParams: new URLSearchParams() }).catch(() => null)
    )
  );
  return (
    <>
      <JsonLd data={seo.buildOfferCatalogJsonLd(packagesList)} />
      <h1 className="sr-only">PC Game Optimization Packages</h1>
      <RouteRenderer pathname="/packages" searchParams={searchParams} initialRouteData={{ packages: { packagesList, packagesSettings: applyHomeSectionCopyOverride("packages-settings", packagesSettings) } }} />
    </>
  );
}
