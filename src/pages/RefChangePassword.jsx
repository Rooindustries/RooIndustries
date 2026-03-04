import Footer from "../components/Footer";
import RefChangePassword from "../components/RefChangePassword";
import SEO from "../components/SEO";

export default function Page() {
  return (
    <>
      <SEO
        title="Change Password | Roo Industries"
        description="Update your Roo Industries referral account password."
        noindex
      />
      <RefChangePassword />
      <Footer />
    </>
  );
}
