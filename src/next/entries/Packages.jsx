"use client";

import Page from "../../legacyPages/Packages";
import LegacyRoutePage from "../LegacyRoutePage";

export default function RouteEntry(props) {
  return <LegacyRoutePage {...props} initialRouteComponent={Page} />;
}
