import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";

export async function generateMetadata({ params }) {
  return seo.getMetadataForPath(`/downloads/${params.slug || ""}`);
}

export default function Page({ params, searchParams }) {
  const slug = params.slug || "";
  return <RouteRenderer pathname={`/downloads/${slug}`} searchParams={searchParams} />;
}
