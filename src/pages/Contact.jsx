import Contact from "../components/Contact";
import Footer from "../components/Footer";
import SEO from "../components/SEO";
export default function ContactPage() {
  return (
    <>
      <SEO
        title="Contact | Roo Industries"
        description="Get in touch to start your PC optimization or ask a question."
      />
      {<Contact />}
      <Footer />
    </>
  );
}
