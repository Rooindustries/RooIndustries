import Footer from "../components/Footer";
import TnC from "../components/Terms";

export default function Terms({ initialData = null }) {
  return (
    <>
      <TnC initialData={initialData} />
      <Footer />
    </>
  );
}
