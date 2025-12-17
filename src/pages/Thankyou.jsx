import Footer from "../components/Footer";
import Thankyou from "../components/Thankyou";

export default function Page({ hideFooter = false }) {
  return (
    <>
      <Thankyou />
      {!hideFooter && <Footer />}
    </>
  );
}
