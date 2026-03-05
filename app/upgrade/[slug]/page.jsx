import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export async function generateMetadata({ params }) {
  return seo.getMetadataForPath(`/upgrade/${params.slug || ""}`);
}

export default function Page({ params, searchParams }) {
  const slug = params.slug || "";
  return (
    <>
      <h1 className="sr-only">Upgrade Booking</h1>
      <RouteRenderer pathname={`/upgrade/${slug}`} searchParams={searchParams} />
    </>
  );
}
