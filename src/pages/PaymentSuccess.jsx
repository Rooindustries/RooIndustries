import PaymentSuccess from "../components/PaymentSuccess";
import Footer from "../components/Footer";

export default function Page({ hideFooter = false }) {
  return (
    <>
      <PaymentSuccess />
      {!hideFooter && <Footer />}
    </>
  );
}
