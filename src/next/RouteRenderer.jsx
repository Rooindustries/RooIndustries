import LegacyRoutePage from "./LegacyRoutePage";
import SeoFallback from "./SeoFallback";
import contentServer from "../lib/contentServer";

export default async function RouteRenderer({
  pathname,
  searchParams,
  initialHomeData = null,
  initialRouteData = null,
  routeJsonLd = null,
  notFound = false,
  entry: Entry = LegacyRoutePage,
}) {
  const resolvedSearchParams = await searchParams;

  return (
    <>
      <SeoFallback pathname={pathname} />
      <Entry
        pathname={pathname}
        searchParams={resolvedSearchParams}
        initialHomeData={initialHomeData}
        initialRouteData={initialRouteData}
        routeJsonLd={routeJsonLd}
        contentRevisions={contentServer.readContentRevisions()}
        notFound={notFound}
      />
    </>
  );
}
