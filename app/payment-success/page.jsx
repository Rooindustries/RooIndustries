import PaymentSuccess from "@/src/next/entries/PaymentSuccess";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/payment-success");

export default function Page({ searchParams }) {
  return <RouteRenderer entry={PaymentSuccess} pathname="/payment-success" searchParams={searchParams} />;
}
