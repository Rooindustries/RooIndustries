"use client";

import Page from "../../legacyPages/MeetTheTeam";
import LegacyRoutePage from "../LegacyRoutePage";

export default function RouteEntry(props) {
  return <LegacyRoutePage {...props} initialRouteComponent={Page} />;
}
