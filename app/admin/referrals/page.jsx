import ReferralCreatorEditor from "../../../src/components/admin/ReferralCreatorEditor";

export const metadata = {
  title: "Referral creator settings | Roo Industries",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function ReferralAdminPage() {
  return <ReferralCreatorEditor />;
}
