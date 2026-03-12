import MeetTheTeam from "../components/MeetTheTeam";
import Footer from "../components/Footer";

export default function MeetTheTeamPage({ initialData = null }) {
  return (
    <>
      <MeetTheTeam initialData={initialData} />
      <Footer />
    </>
  );
}
