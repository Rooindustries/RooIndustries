import Packages from "@/src/next/entries/Packages";
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
  const packagesData = {
    packagesList,
    packagesSettings: applyHomeSectionCopyOverride("packages-settings", packagesSettings),
  };
  return (
    <>
      <JsonLd data={seo.buildOfferCatalogJsonLd(packagesList)} />
      <RouteRenderer
        entry={Packages}
        pathname="/packages"
        searchParams={searchParams}
        initialRouteData={{ packages: packagesData }}
      />
    </>
  );
}
