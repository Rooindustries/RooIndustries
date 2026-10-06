import ContentAdmin from "../../../src/components/admin/content/ContentAdmin";

export const metadata = {
  title: "Site content | Roo Industries",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function ContentAdminPage() {
  return <ContentAdmin />;
}
