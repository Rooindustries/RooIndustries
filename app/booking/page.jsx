import Book from "@/src/next/entries/Book";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/booking");

export default async function Page({ searchParams }) {
  const homePageData = await contentServer.fetchFlowPageHomeData();
  return <RouteRenderer entry={Book} pathname="/booking" searchParams={searchParams} initialHomeData={homePageData} />;
}
