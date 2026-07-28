import { TourneyStyles } from "../../TourneyShared";
import {
  buildPublicBracketResponse,
  readPublicBracketApiSnapshot,
} from "../../../../src/server/tourney/publicBracketApi";
import { OverlayStyles } from "../OverlayStyles";
import BracketOverlayClient from "./BracketOverlayClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Bracket Overlay | Roo Industries",
};

const clampNumber = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
};

const EMPTY_OVERLAY_DATA = Object.freeze({
  ok: true,
  apiVersion: "1",
  version: "",
  updatedAt: "",
  generated: false,
  published: false,
  teams: [],
  groups: [],
  matches: [],
});

export default async function BracketOverlayPage({ searchParams }) {
  const params = await searchParams;
  const pollSeconds = clampNumber(params?.poll, 3, 60, 10);
  const scale = clampNumber(params?.scale, 0.6, 2, 1);
  const group = String(params?.group || "").trim().toLowerCase();
  const demoBackground = String(params?.bg || "").toLowerCase() === "gradient";

  const snapshot = await readPublicBracketApiSnapshot().catch(() => null);
  const initialData = snapshot
    ? buildPublicBracketResponse(snapshot)
    : EMPTY_OVERLAY_DATA;

  return (
    <>
      <TourneyStyles />
      <OverlayStyles />
      <BracketOverlayClient
        initialData={initialData}
        pollSeconds={pollSeconds}
        scale={scale}
        group={group}
        demoBackground={demoBackground}
      />
    </>
  );
}
