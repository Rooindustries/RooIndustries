import Thankyou from "@/src/next/entries/Thankyou";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/thank-you");

export default async function Page({ searchParams }) {
  const homePageData = await contentServer.fetchFlowPageHomeData();
  return <RouteRenderer entry={Thankyou} pathname="/thank-you" searchParams={searchParams} initialHomeData={homePageData} />;
}
