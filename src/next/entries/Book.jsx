"use client";

import Home from "../../legacyPages/Home";
import LegacyRoutePage from "../LegacyRoutePage";

export default function RouteEntry(props) {
  return <LegacyRoutePage {...props} initialHomeComponent={Home} />;
}
