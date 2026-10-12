"use client";

import Page from "../../legacyPages/Thankyou";
import Home from "../../legacyPages/Home";
import LegacyRoutePage from "../LegacyRoutePage";

export default function RouteEntry(props) {
  return <LegacyRoutePage {...props} initialRouteComponent={Page} initialHomeComponent={Home} />;
}
