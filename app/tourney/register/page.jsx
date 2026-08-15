import { notFound } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Creator Registration | Roo Industries",
  description: "Private creator Roo Industries tournament registration page.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default function TourneyRegisterPage() {
  notFound();
}
