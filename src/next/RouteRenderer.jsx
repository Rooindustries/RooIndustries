import LegacyRoutePage from "./LegacyRoutePage";
import SeoFallback from "./SeoFallback";
import sanityServer from "../lib/sanityServer";

export default async function RouteRenderer({
  pathname,
  searchParams,
  initialHomeData = null,
}) {
  const resolvedHomeData =
    initialHomeData ??
    (pathname === "/" ? null : await sanityServer.fetchHomePageData());

  return (
    <>
      <SeoFallback pathname={pathname} />
      <LegacyRoutePage
        pathname={pathname}
        searchParams={searchParams}
        initialHomeData={resolvedHomeData}
      />
    </>
  );
}
