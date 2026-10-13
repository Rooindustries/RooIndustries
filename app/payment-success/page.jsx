import PaymentSuccess from "@/src/next/entries/PaymentSuccess";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/payment-success");

export default async function Page({ searchParams }) {
  const homePageData = await contentServer.fetchFlowPageHomeData();
  return <RouteRenderer entry={PaymentSuccess} pathname="/payment-success" searchParams={searchParams} initialHomeData={homePageData} />;
}
