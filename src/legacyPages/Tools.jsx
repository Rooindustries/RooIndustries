import Footer from "../components/Footer";
import Tools from "../components/Tools";

export default function Page({ initialData = null }) {
  return (
    <>
      <Tools initialData={initialData} />
      <Footer />
    </>
  );
}
