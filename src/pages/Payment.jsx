import PaymentComp from "../components/Payment";
import Footer from "../components/Footer";

export default function Payment({ hideFooter = false }) {
  return (
    <>
      <PaymentComp hideFooter={hideFooter} />
      {!hideFooter && <Footer />}
    </>
  );
}
