import { redirect } from "next/navigation";
import { LockScreen, getTourneySession } from "../TourneyShared";
import SupabaseSocialLogin from "../../../src/components/SupabaseSocialLogin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sign In | Roo Industries",
  description: "Sign in to a Roo Industries event account.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

const normalizeNextPath = (value) => {
  const path = String(value || "/tourney").trim();
  if (
    !path.startsWith("/tourney") ||
    path.startsWith("//") ||
    path.startsWith("/api/") ||
    path === "/tourney/login"
  ) {
    return "/tourney";
  }
  return path;
};

export default async function TourneyLoginPage({ searchParams }) {
  const resolvedSearchParams = await searchParams;
  const session = await getTourneySession();

  if (session) {
    redirect("/tourney");
  }

  return (
    <LockScreen
      error={resolvedSearchParams?.error || ""}
      heading="Sign in."
      subtitle="Caster, player, and owner access."
      note="Wait for approval before trying to log in."
      buttonLabel="Sign in"
      redirectTo={normalizeNextPath(resolvedSearchParams?.next)}
      socialLogin={
        <SupabaseSocialLogin
          flow="tourney"
          nextPath={normalizeNextPath(resolvedSearchParams?.next)}
          variant="tourney"
        />
      }
    />
  );
}
