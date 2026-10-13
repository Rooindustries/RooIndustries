"use client";

import Page from "../../legacyPages/Book";
import Home from "../../legacyPages/Home";
import BookingModal from "../../components/BookingModal";
import LegacyRoutePage from "../LegacyRoutePage";

export default function RouteEntry(props) {
  return <LegacyRoutePage {...props} initialRouteComponent={Page} initialHomeComponent={Home} initialBookingModalComponent={BookingModal} />;
}
