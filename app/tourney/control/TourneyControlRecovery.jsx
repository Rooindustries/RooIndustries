"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function TourneyControlRecovery() {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(id);
  }, [router]);

  return (
    <p className="cs-error" role="alert">
      Bracket data is temporarily unavailable. Match controls will reconnect
      automatically.
    </p>
  );
}
