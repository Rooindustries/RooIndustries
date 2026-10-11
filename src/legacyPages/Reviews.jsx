import MoreReviews from "../components/MoreReviews";
import Footer from "../components/Footer";

export default function Reviews({ initialData = null }) {
  return (
    <>
      <MoreReviews initialData={initialData} />
      <Footer />
    </>
  );
}
