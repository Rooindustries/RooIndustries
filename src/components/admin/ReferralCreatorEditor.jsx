"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, KeyRound, RefreshCw, Search } from "lucide-react";
import styles from "./ReferralCreatorEditor.module.css";

const percent = (basisPoints) => {
  const value = Number(basisPoints || 0) / 100;
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "");
};

const createDraft = (creator) => ({
  totalPercent: percent(creator.total_basis_points),
  commissionPercent: percent(creator.commission_basis_points),
  discountPercent: percent(creator.discount_basis_points),
  bypassUnlock: creator.bypass_referral_requirement === true,
  reason: "",
});

const displayTime = (value) => {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
};

const allocationLabel = (terms = {}) => {
  const commission = Number(terms.commission_basis_points || 0) / 100;
  const discount = Number(terms.discount_basis_points || 0) / 100;
  const total = Number(terms.total_basis_points || 0) / 100;
  return `${commission}% commission + ${discount}% discount of ${total}% total`;
};

export default function ReferralCreatorEditor() {
  const [adminKey, setAdminKey] = useState("");
  const [creators, setCreators] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState(null);
  const [history, setHistory] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const pendingOperation = useRef("");
  const latestCreatorRequest = useRef(0);
  const latestHistoryRequest = useRef(0);
  const latestSaveRequest = useRef(0);
  const lastLoadedSearch = useRef("");
  const creatorsRef = useRef([]);
  const selectedIdRef = useRef("");
  const draftRef = useRef(null);
  const draftDirtyRef = useRef(false);

  const selected = creators.find((creator) => creator.creator_id === selectedId) || null;

  const replaceCreators = (nextCreators) => {
    creatorsRef.current = nextCreators;
    setCreators(nextCreators);
  };

  const replaceDraft = (nextDraft, dirty = false) => {
    draftRef.current = nextDraft;
    draftDirtyRef.current = dirty;
    setDraft(nextDraft);
  };

  const request = async (path, options = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": adminKey,
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const requestError = new Error(body.error || "Request failed.");
      requestError.status = response.status;
      throw requestError;
    }
    return body;
  };

  const loadCreators = async ({
    search = query,
    offset = 0,
    append = false,
    authorize = false,
  } = {}) => {
    const requestId = latestCreatorRequest.current + 1;
    latestCreatorRequest.current = requestId;
    const normalizedSearch = String(search || "").trim();
    setLoading(true);
    setError("");
    try {
      const parameters = new URLSearchParams({
        search: normalizedSearch,
        offset: String(offset),
        limit: "50",
      });
      const body = await request(`/api/admin/referral-creators?${parameters}`);
      if (requestId !== latestCreatorRequest.current) return;
      const page = Array.isArray(body.creators) ? body.creators : [];
      const existingCreators = creatorsRef.current;
      let nextCreators = append
        ? [...new Map(
            [...existingCreators, ...page].map((creator) => [creator.creator_id, creator])
          ).values()]
        : page;
      const currentSelected = existingCreators.find(
        (creator) => creator.creator_id === selectedIdRef.current
      );
      if (draftDirtyRef.current && currentSelected) {
        nextCreators = nextCreators.filter(
          (creator) => creator.creator_id !== currentSelected.creator_id
        );
        nextCreators.unshift(currentSelected);
      }
      replaceCreators(nextCreators);
      const refreshedSelection = nextCreators.find(
        (creator) => creator.creator_id === selectedIdRef.current
      );
      if (refreshedSelection && !draftDirtyRef.current) {
        replaceDraft(createDraft(refreshedSelection));
      } else if (!append && !draftDirtyRef.current) {
        selectedIdRef.current = "";
        setSelectedId("");
        replaceDraft(null);
        setHistory([]);
      }
      setHasMore(body.hasMore === true);
      lastLoadedSearch.current = normalizedSearch;
      setUnlocked(true);
    } catch (loadError) {
      if (requestId !== latestCreatorRequest.current) return;
      if (authorize) setUnlocked(false);
      setError(loadError.message);
    } finally {
      if (requestId === latestCreatorRequest.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!unlocked) return undefined;
    const normalizedSearch = query.trim();
    if (normalizedSearch === lastLoadedSearch.current) return undefined;
    const timer = window.setTimeout(() => {
      loadCreators({ search: normalizedSearch });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, unlocked]);

  const selectCreator = async (creator) => {
    if (selectedIdRef.current === creator.creator_id) return;
    if (
      draftDirtyRef.current &&
      typeof globalThis.confirm === "function" &&
      !globalThis.confirm("Discard the unsaved creator changes?")
    ) {
      return;
    }
    const requestId = latestHistoryRequest.current + 1;
    latestHistoryRequest.current = requestId;
    selectedIdRef.current = creator.creator_id;
    setSelectedId(creator.creator_id);
    replaceDraft(createDraft(creator));
    setHistory([]);
    pendingOperation.current = "";
    setError("");
    setNotice("");
    try {
      const body = await request(
        `/api/admin/referral-creators?creatorId=${encodeURIComponent(creator.creator_id)}`
      );
      if (
        requestId !== latestHistoryRequest.current ||
        selectedIdRef.current !== creator.creator_id
      ) return;
      setHistory(body.history || []);
    } catch (historyError) {
      if (
        requestId !== latestHistoryRequest.current ||
        selectedIdRef.current !== creator.creator_id
      ) return;
      setError(historyError.message);
    }
  };

  const updateDraft = (field, value) => {
    pendingOperation.current = "";
    const nextDraft = { ...draftRef.current, [field]: value };
    replaceDraft(nextDraft, true);
  };

  const save = async () => {
    if (!selected || !draft) return;
    const creatorId = selected.creator_id;
    const creatorSnapshot = selected;
    const draftSnapshot = { ...draft };
    const selectionRequestId = latestHistoryRequest.current;
    const saveRequestId = latestSaveRequest.current + 1;
    latestSaveRequest.current = saveRequestId;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const operationId = pendingOperation.current || crypto.randomUUID();
      pendingOperation.current = operationId;
      const body = await request("/api/admin/referral-creators", {
        method: "PATCH",
        body: JSON.stringify({
          creatorId,
          expectedVersion: creatorSnapshot.terms_version,
          operationId,
          ...draftSnapshot,
        }),
      });
      const updated = {
        ...creatorSnapshot,
        total_basis_points: body.creator.total_basis_points,
        commission_basis_points: body.creator.commission_basis_points,
        discount_basis_points: body.creator.discount_basis_points,
        bypass_referral_requirement: body.creator.bypass_referral_requirement,
        terms_version: body.creator.terms_version,
        updated_at: body.creator.updated_at,
      };
      const nextCreators = creatorsRef.current.map((creator) =>
        creator.creator_id === updated.creator_id ? updated : creator
      );
      replaceCreators(nextCreators);
      const selectionStillCurrent =
        selectedIdRef.current === creatorId &&
        latestHistoryRequest.current === selectionRequestId &&
        latestSaveRequest.current === saveRequestId;
      if (!selectionStillCurrent) return;
      replaceDraft(createDraft(updated));
      pendingOperation.current = "";
      setNotice(
        body.syncPending
          ? "Saved in Supabase. Sanity fallback sync is queued."
          : "Saved in Supabase and synchronized to the Sanity fallback."
      );
      try {
        const refreshed = await request(
          `/api/admin/referral-creators?creatorId=${encodeURIComponent(updated.creator_id)}`
        );
        if (
          selectedIdRef.current !== creatorId ||
          latestHistoryRequest.current !== selectionRequestId ||
          latestSaveRequest.current !== saveRequestId
        ) return;
        setHistory(refreshed.history || []);
      } catch {
        if (
          selectedIdRef.current !== creatorId ||
          latestHistoryRequest.current !== selectionRequestId ||
          latestSaveRequest.current !== saveRequestId
        ) return;
        setHistory([]);
      }
    } catch (saveError) {
      if (
        selectedIdRef.current !== creatorId ||
        latestHistoryRequest.current !== selectionRequestId ||
        latestSaveRequest.current !== saveRequestId
      ) return;
      if ([400, 404, 409].includes(Number(saveError.status))) {
        pendingOperation.current = "";
      }
      setError(saveError.message);
    } finally {
      if (latestSaveRequest.current === saveRequestId) setSaving(false);
    }
  };

  if (!unlocked) {
    return (
      <main className={styles.shell}>
        <section className={styles.accessCard}>
          <div className={styles.iconBox}><KeyRound aria-hidden="true" /></div>
          <p className={styles.eyebrow}>Private admin</p>
          <h1>Referral creator settings</h1>
          <p className={styles.intro}>
            Enter the referral admin key to manage creator eligibility and percentages.
          </p>
          <form
            className={styles.accessForm}
            onSubmit={(event) => {
              event.preventDefault();
              loadCreators({ search: query, authorize: true });
            }}
          >
            <label htmlFor="ref-admin-key">Admin key</label>
            <input
              id="ref-admin-key"
              type="password"
              autoComplete="off"
              value={adminKey}
              onChange={(event) => setAdminKey(event.target.value)}
              required
            />
            <button type="submit" disabled={loading || !adminKey.trim()}>
              {loading ? "Opening…" : "Open editor"}
            </button>
          </form>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Supabase primary</p>
          <h1>Referral creator settings</h1>
          <p className={styles.intro}>
            Control the total allowance, customer discount, creator commission, and unlock bypass.
          </p>
        </div>
        <button
          className={styles.secondaryButton}
          onClick={() => loadCreators({ search: query })}
          disabled={loading}
        >
          <RefreshCw size={17} aria-hidden="true" />
          Refresh
        </button>
      </header>

      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {notice ? <p className={styles.notice} role="status"><Check size={17} />{notice}</p> : null}

      <div className={styles.workspace}>
        <aside className={styles.creatorPanel}>
          <div className={styles.searchBox}>
            <Search size={17} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search creators"
              placeholder="Search name, code, or email"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <p className={styles.count}>
            {creators.length}{hasMore ? "+" : ""} creators
          </p>
          <div className={styles.creatorList}>
            {creators.map((creator) => (
              <button
                key={creator.creator_id}
                className={creator.creator_id === selectedId ? styles.creatorActive : styles.creator}
                onClick={() => selectCreator(creator)}
              >
                <span>
                  <strong>{creator.name || creator.referral_code}</strong>
                  <small>{creator.referral_code} · {percent(creator.total_basis_points)}% total</small>
                </span>
                <ChevronRight size={17} aria-hidden="true" />
              </button>
            ))}
            {hasMore ? (
              <button
                className={styles.loadMore}
                onClick={() => loadCreators({
                  search: query,
                  offset: creators.length,
                  append: true,
                })}
                disabled={loading}
              >
                {loading ? "Loading…" : "Load more creators"}
              </button>
            ) : null}
          </div>
        </aside>

        <section className={styles.editorPanel}>
          {!selected || !draft ? (
            <div className={styles.emptyState}>
              <h2>Select a creator</h2>
              <p>Choose a creator to review or change their referral terms.</p>
            </div>
          ) : (
            <>
              <div className={styles.creatorHeader}>
                <div>
                  <p className={styles.eyebrow}>{selected.referral_code}</p>
                  <h2>{selected.name || selected.referral_code}</h2>
                  <p>{selected.creator_email || "No email in fallback record"}</p>
                </div>
                <span className={styles.referralCount}>
                  {selected.successful_referrals} successful referrals
                </span>
              </div>

              <div className={styles.fields}>
                <label>
                  <span>Total percentage allowed</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={draft.totalPercent}
                    onChange={(event) => updateDraft("totalPercent", event.target.value)}
                  />
                </label>
                <label>
                  <span>Customer discount percentage</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={draft.discountPercent}
                    onChange={(event) => updateDraft("discountPercent", event.target.value)}
                  />
                </label>
                <label>
                  <span>Creator commission percentage</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={draft.commissionPercent}
                    onChange={(event) => updateDraft("commissionPercent", event.target.value)}
                  />
                </label>
              </div>

              <label className={styles.toggleRow}>
                <span>
                  <strong>Bypass five-referral requirement</strong>
                  <small>Allow this creator to change their split before five successful referrals.</small>
                </span>
                <input
                  type="checkbox"
                  checked={draft.bypassUnlock}
                  onChange={(event) => updateDraft("bypassUnlock", event.target.checked)}
                />
              </label>

              <label className={styles.reasonField}>
                <span>Reason for change</span>
                <textarea
                  rows="3"
                  maxLength="500"
                  value={draft.reason}
                  onChange={(event) => updateDraft("reason", event.target.value)}
                  placeholder="Example: Contracted creator rate approved"
                />
              </label>

              <div className={styles.saveRow}>
                <p>Version {selected.terms_version}</p>
                <button onClick={save} disabled={saving || draft.reason.trim().length < 3}>
                  {saving ? "Saving…" : "Save creator settings"}
                </button>
              </div>

              <div className={styles.history}>
                <div className={styles.historyHeader}>
                  <h3>Audit history</h3>
                  <span>{history.length} changes</span>
                </div>
                {history.length === 0 ? (
                  <p className={styles.historyEmpty}>No editor changes recorded yet.</p>
                ) : history.map((entry) => (
                  <article key={entry.id} className={styles.historyEntry}>
                    <div>
                      <strong>{entry.reason}</strong>
                      <time>{displayTime(entry.created_at)}</time>
                    </div>
                    <p>{allocationLabel(entry.new_terms)}</p>
                    <span>{entry.new_terms?.bypass_referral_requirement ? "Bypass enabled" : "Standard eligibility"}</span>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
