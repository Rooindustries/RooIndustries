import Home from "@/src/next/entries/Home";
import RouteRenderer from "@/src/next/RouteRenderer";
import JsonLd from "@/src/next/JsonLd";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export const dynamic = "force-static";
export const revalidate = 60;

export default async function Page() {
  const homePageData = await contentServer.fetchHomePageData({
    fresh: true,
    requireContent: process.env.NEXT_PHASE !== "phase-production-build",
  });

  return (
    <>
      <JsonLd data={seo.buildOrganizationJsonLd()} />
      <JsonLd data={seo.buildHomePageJsonLd(homePageData?.hero)} />
      <RouteRenderer entry={Home}
        pathname="/"
        searchParams={{}}
        initialHomeData={homePageData}
      />
    </>
  );
}
