import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Faqs from "../components/Faq";
import Footer from "../components/Footer";

export default function Faq() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (location.pathname === "/faq") {
      navigate("/#faq", { replace: true });
    }
  }, [location.pathname, navigate]);

  return (
    <>
      <Faqs />
      <Footer />
    </>
  );
}
