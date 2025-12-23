import Privacy from "../components/PrivacyPolicy";
import Footer from "../components/Footer";
import SEO from "../components/SEO";

export default function PrivacyPolicy() {
  return (
    <>
      <SEO
        title="Privacy Policy | Roo Industries"
        description="How Roo Industries collects, uses, and protects your data."
      />
      <Privacy />
      <Footer />
    </>
  );
}
