import Footer from "../components/Footer";
import RefRegister from "../components/RefRegister";
import SEO from "../components/SEO";

export default function Page() {
  return (
    <>
      <SEO
        title="Referral Sign Up | Roo Industries"
        description="Join the Roo Industries referral program and earn rewards for every customer you refer."
      />
      <RefRegister />
      <Footer />
    </>
  );
}
