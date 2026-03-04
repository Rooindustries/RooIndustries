import Footer from "../components/Footer";
import RefLogin from "../components/RefLogin";
import SEO from "../components/SEO";

export default function Page() {
  return (
    <>
      <SEO
        title="Referral Login | Roo Industries"
        description="Log in to your Roo Industries referral account to track earnings and referrals."
      />
      <RefLogin />
      <Footer />
    </>
  );
}
