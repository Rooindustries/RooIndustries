import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Faqs from "../components/Faq";
import Footer from "../components/Footer";
import SEO from "../components/SEO";
import { isReactSnap } from "../utils/prerenderState";

export default function Faq() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (isReactSnap()) return;
    if (location.pathname === "/faq") {
      navigate("/#faq", { replace: true });
    }
  }, [location.pathname, navigate]);

  return (
    <>
      <SEO
        title="FAQ | Roo Industries"
        description="Answers to common questions about our optimization process, safety, and results."
      />
      <Faqs />
      <Footer />
    </>
  );
}
