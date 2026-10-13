import Payment from "@/src/next/entries/Payment";
import { preload } from "react-dom";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import contentServer from "@/src/lib/contentServer";

export const metadata = seo.getMetadataForPath("/payment");

export default async function Page({ searchParams }) {
  preload("https://razorpay.com/assets/razorpay-logo.svg", { as: "image" });
  const homePageData = await contentServer.fetchFlowPageHomeData();
  return <RouteRenderer entry={Payment} pathname="/payment" searchParams={searchParams} initialHomeData={homePageData} />;
}
