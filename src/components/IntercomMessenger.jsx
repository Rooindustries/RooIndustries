import { useLocation } from "react-router-dom";
import { IntercomMessengerCore } from "./IntercomMessengerCore";

function IntercomMessenger({ disabledRoutes = [] }) {
  const location = useLocation();

  return (
    <IntercomMessengerCore
      disabledRoutes={disabledRoutes}
      pathname={location.pathname || "/"}
    />
  );
}

export default IntercomMessenger;
