import Footer from "../components/Footer";
import RefReset from "../components/RefReset";
import SEO from "../components/SEO";

export default function Page() {
  return (
    <>
      <SEO
        title="Reset Password | Roo Industries"
        description="Set a new password for your Roo Industries referral account."
      />
      <RefReset />
      <Footer />
    </>
  );
}
