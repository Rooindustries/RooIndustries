import RouteRenderer from "@/src/next/RouteRenderer";
import JsonLd from "@/src/next/JsonLd";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export default async function Page({ searchParams }) {
  const homePageData = await contentServer.fetchHomePageData();

  return (
    <>
      <JsonLd data={seo.buildOrganizationJsonLd()} />
      <JsonLd data={seo.buildHomePageJsonLd(homePageData?.hero)} />
      <JsonLd data={seo.buildOfferCatalogJsonLd()} />
      <RouteRenderer
        pathname="/"
        searchParams={searchParams}
        initialHomeData={homePageData}
      />
    </>
  );
}
