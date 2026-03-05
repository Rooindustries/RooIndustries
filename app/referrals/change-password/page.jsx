import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/referrals/change-password");

export default function Page({ searchParams }) {
  return <RouteRenderer pathname="/referrals/change-password" searchParams={searchParams} />;
}
