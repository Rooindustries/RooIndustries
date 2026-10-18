import Userbenchmarks from "../components/Benchmarks";
import Footer from "../components/Footer";

export default function Benchmarks({ initialData = null, setIsModalOpen }) {
  return (
    <>
      {<Userbenchmarks initialData={initialData} setIsModalOpen={setIsModalOpen} />}
      {<Footer />}
    </>
  );
}
