import RouteRenderer from "@/src/next/RouteRenderer";

export const metadata = {
  title: "Confirm Creator Account | Roo Industries",
  robots: { index: false, follow: false, nocache: true },
};

export default function Page({ searchParams }) {
  return <RouteRenderer pathname="/referrals/verify" searchParams={searchParams} />;
}
