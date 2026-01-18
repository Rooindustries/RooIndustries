import MeetTheTeam from "../components/MeetTheTeam";
import Footer from "../components/Footer";
import SEO from "../components/SEO";

export default function MeetTheTeamPage() {
  return (
    <>
      <SEO
        title="Meet The Team"
        description="The crew behind your performance gains."
      />
      <MeetTheTeam />
      <Footer />
    </>
  );
}
