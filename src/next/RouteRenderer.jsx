import LegacyRoutePage from "./LegacyRoutePage";
import SeoFallback from "./SeoFallback";

export default async function RouteRenderer({
  pathname,
  searchParams,
  initialHomeData = null,
  initialRouteData = null,
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
        notFound={notFound}
      />
    </>
  );
}
