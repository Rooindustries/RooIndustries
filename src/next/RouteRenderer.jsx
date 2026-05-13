import LegacyRoutePage from "./LegacyRoutePage";
import MaintenancePage from "../components/MaintenancePage";
import SeoFallback from "./SeoFallback";
import marketConfig from "../lib/market";
import sanityServer from "../lib/sanityServer";
import siteMode from "../lib/siteMode";

const { resolveMarket } = marketConfig;
const { shouldShowMaintenancePage } = siteMode;

export default async function RouteRenderer({
  pathname,
  searchParams,
  initialHomeData = null,
}) {
  const resolvedSearchParams = await searchParams;
  const siteSettings = await sanityServer.fetchSiteSettings();
  const market = resolveMarket();

  if (shouldShowMaintenancePage({ market, settings: siteSettings })) {
    return <MaintenancePage />;
  }

  const resolvedHomeData =
    initialHomeData ??
    (pathname === "/" ? null : await sanityServer.fetchHomePageData());

  return (
    <>
      <SeoFallback pathname={pathname} />
      <LegacyRoutePage
        pathname={pathname}
        searchParams={resolvedSearchParams}
        initialHomeData={resolvedHomeData}
      />
    </>
  );
}
