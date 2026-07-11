"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/src/lib/supabaseBrowser";
import styles from "./account.module.css";

export default function AccountPage() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const client = getSupabaseBrowserClient();
    client.auth.getUser().then(({ data }) => {
      if (!data?.user) {
        window.location.replace("/account/login");
        return;
      }
      setUser(data.user);
      setLoading(false);
    });
  }, []);

  const signOut = async () => {
    await getSupabaseBrowserClient().auth.signOut();
    window.location.replace("/account/login");
  };

  return (
    <main className={styles.shell}>
      <section className={styles.card} aria-live="polite">
        <p className={styles.eyebrow}>Roo Industries account</p>
        <h1>{loading ? "Loading account…" : "You’re signed in"}</h1>
        {user ? (
          <>
            <p className={styles.intro}>{user.email || "Verified account"}</p>
            <button className={styles.secondaryButton} onClick={signOut} type="button">
              Sign out
            </button>
          </>
        ) : null}
      </section>
    </main>
  );
}
