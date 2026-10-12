import RefChangePassword from "@/src/next/entries/RefChangePassword";
import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export const metadata = seo.getMetadataForPath("/referrals/change-password");

export default function Page({ searchParams }) {
  return <RouteRenderer entry={RefChangePassword} pathname="/referrals/change-password" searchParams={searchParams} />;
}
