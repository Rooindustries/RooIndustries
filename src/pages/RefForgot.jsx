import Footer from "../components/Footer";
import RefForgot from "../components/RefForgot";
import SEO from "../components/SEO";

export default function Page() {
  return (
    <>
      <SEO
        title="Forgot Password | Roo Industries"
        description="Reset your Roo Industries referral account password."
      />
      <RefForgot />
      <Footer />
    </>
  );
}
