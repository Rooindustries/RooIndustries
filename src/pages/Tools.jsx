import Footer from "../components/Footer";
import Tools from "../components/Tools";
import SEO from "../components/SEO";

export default function Page() {
  return (
    <>
      <SEO
        title="Tools & Downloads | Roo Industries"
        description="Free tools and downloads to help optimize your PC performance."
      />
      <Tools />
      <Footer />
    </>
  );
}
