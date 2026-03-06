import Faqs from "../components/Faq";
import Footer from "../components/Footer";

export default function Faq({ initialData = null }) {
  return (
    <>
      <Faqs
        initialFaqCopy={initialData?.faqSettings || null}
        initialQuestions={initialData?.faqQuestions || null}
      />
      <Footer />
    </>
  );
}
