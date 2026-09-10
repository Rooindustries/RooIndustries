import Privacy from "../components/PrivacyPolicy";
import Footer from "../components/Footer";

export default function PrivacyPolicy({ initialData = null }) {
  return (
    <>
      <Privacy initialData={initialData} />
      <Footer />
    </>
  );
}
