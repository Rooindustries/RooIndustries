import Payment from "@/src/next/entries/Payment";
import { preload } from "react-dom";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/payment");

export default function Page({ searchParams }) {
  preload("https://razorpay.com/assets/razorpay-logo.svg", { as: "image" });
  return <RouteRenderer entry={Payment} pathname="/payment" searchParams={searchParams} />;
}
