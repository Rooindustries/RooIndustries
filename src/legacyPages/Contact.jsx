import Contact from "../components/Contact";
import Footer from "../components/Footer";
export default function ContactPage({ initialData = null }) {
  return (
    <>
      {<Contact initialData={initialData} />}
      <Footer />
    </>
  );
}
