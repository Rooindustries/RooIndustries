import LegacyRoutePage from "./LegacyRoutePage";
import SeoFallback from "./SeoFallback";

export default async function RouteRenderer({
  pathname,
  searchParams,
  initialHomeData = null,
}) {
  const resolvedSearchParams = await searchParams;

  return (
    <>
      <SeoFallback pathname={pathname} />
      <LegacyRoutePage
        pathname={pathname}
        searchParams={resolvedSearchParams}
        initialHomeData={initialHomeData}
      />
    </>
  );
}
