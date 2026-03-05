import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/referrals/login");

export default function Page({ searchParams }) {
  return <RouteRenderer pathname="/referrals/login" searchParams={searchParams} />;
}
