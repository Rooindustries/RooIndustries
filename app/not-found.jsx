import RouteRenderer from "@/src/next/RouteRenderer";
import seo from "@/src/lib/seo";
import { connection } from "next/server";

export const metadata = seo.getMetadataForPath("/404");

export default async function NotFound() {
  await connection();
  return <RouteRenderer pathname="/__missing__" searchParams={{}} />;
}
