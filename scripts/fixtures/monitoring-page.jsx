"use client";

import { useEffect, useState } from "react";
import { reportClientError } from "@/src/lib/monitoring/client";

export default function MonitoringFixture() {
  const [failed, setFailed] = useState(false);
  useEffect(() => { document.body.dataset.monitoringReady = "1"; }, []);
  if (failed) throw new Error("Fixture browser boundary");
  return (
    <main>
      <button onClick={() => setTimeout(() => { throw new Error("Fixture browser uncaught"); }, 0)}>Uncaught error</button>
      <button onClick={() => Promise.reject(new Error("Fixture browser rejection"))}>Rejected promise</button>
      <button onClick={() => reportClientError(new Error("Fixture browser reported"))}>Reported error</button>
      <button onClick={async () => {
        const { startBrowserMonitoring } = await import("@/src/lib/monitoring/browser");
        startBrowserMonitoring(process.env.NEXT_PUBLIC_SENTRY_DSN)?.captureException(new Error("Fixture browser direct"));
      }}>Direct initializer</button>
      <button onClick={() => setFailed(true)}>Error boundary</button>
    </main>
  );
}
