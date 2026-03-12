import LegacyRoutePage from "./LegacyRoutePage";
import SeoFallback from "./SeoFallback";

export default function RouteRenderer({
  pathname,
  searchParams,
  initialRouteData = null,
}) {
  return (
    <>
      <SeoFallback pathname={pathname} />
      <LegacyRoutePage
        pathname={pathname}
        searchParams={searchParams}
        initialRouteData={initialRouteData}
      />
    </>
  );
}
