import RefDashboard from "@/src/next/entries/RefDashboard";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/referrals/dashboard");

export default function Page({ searchParams }) {
  return <RouteRenderer entry={RefDashboard} pathname="/referrals/dashboard" searchParams={searchParams} />;
}
