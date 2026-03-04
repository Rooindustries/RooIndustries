import Footer from "../components/Footer";
import RefDashboard from "../components/RefDashboard";
import SEO from "../components/SEO";

export default function Page() {
  return (
    <>
      <SEO
        title="Referral Dashboard | Roo Industries"
        description="Track your referral earnings and performance."
        noindex
      />
      <RefDashboard />
      <Footer />
    </>
  );
}
