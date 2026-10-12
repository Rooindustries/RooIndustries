"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  FilePlus2,
  History,
  ImageIcon,
  KeyRound,
  LayoutList,
  Lock,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import {
  CONTENT_TYPES,
  createContentDefaults,
  validateContentDocument,
} from "../../../lib/cms/contentSchema";
import styles from "./ContentAdmin.module.css";
import { AdminApiError, createAdminApi } from "./adminApi";
import { EditorContext, ObjectFields } from "./FieldInput";
import RevisionHistory from "./RevisionHistory";
import { clearDraft, draftKey, listNewDrafts, readDraft, saveDraft } from "./draftStore";
import { contentErrorLabel, getIn, indexErrors, newUuid, resolveStablePath, setIn, stableJson, toStablePath } from "./documentPaths";
import { hasCommittedCreateReceipt, publishedContentMatches, removedContentPaths } from "./publishStatus";

const GROUPS = [
  { id: "site", title: "Site content" },
  { id: "commerce", title: "Commerce" },
  { id: "policies", title: "Policies" },
];

const TYPES_BY_NAME = new Map(CONTENT_TYPES.map((type) => [type.name, type]));

const displayTime = (value) => {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
};

const documentTitle = (type, document, fallback = "Untitled") => {
  const titleField = type?.preview?.title;
  const value = titleField ? document?.[titleField] : document?.title;
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
};

const PUBLISH_NOTICE = "Published. The live site picks this up within a few minutes (page and CDN caches).";

export default function ContentAdmin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [draftError, setDraftError] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [gateError, setGateError] = useState("");
  const api = useMemo(() => createAdminApi(), []);

  const [typeName, setTypeName] = useState("");
  const [lists, setLists] = useState({});
  const [pane, setPane] = useState("types");
  const [listFilter, setListFilter] = useState("");
  const workspaceRef = useRef(null);

  const [session, setSession] = useState(null);
  const [working, setWorking] = useState(null);
  const [assets, setAssets] = useState({});
  const [loadVersion, setLoadVersion] = useState(0);
  const [loadingDocument, setLoadingDocument] = useState(false);

  const [errors, setErrors] = useState([]);
  const [banner, setBanner] = useState(null);
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pendingPublication, setPendingPublication] = useState(null);
  const [locking, setLocking] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [uploadsInFlight, setUploadsInFlight] = useState(0);

  const referenceCache = useRef(new Map());
  const listRequest = useRef({});
  const selection = useRef(0);
  const editorState = useRef(null);
  const workingRef = useRef(null);
  const sessionKeyRef = useRef("");

  const type = TYPES_BY_NAME.get(typeName) || null;
  const baseline = session?.baseline ?? null;
  const dirty = Boolean(session && working && stableJson(working) !== stableJson(baseline));
  const currentDraftKey = session ? draftKey(session) : null;
  const generation = selection.current;
  editorState.current = { session, working, assets, dirty, currentDraftKey, locking, saving, pendingPublication };
  workingRef.current = working;
  sessionKeyRef.current = session ? `${generation}:${session.documentId || session.createIntentId}:${loadVersion}` : "";

  const isCurrentSelection = useCallback((value) => value === selection.current, []);
  const advanceSelection = useCallback(() => {
    selection.current += 1;
    sessionKeyRef.current = "";
    referenceCache.current.clear();
    setSaving(false);
    setPendingPublication(null);
    setUploadsInFlight(0);
    setLoadingDocument(false);
    setHistoryOpen(false);
    return selection.current;
  }, []);

  useEffect(() => () => { selection.current += 1; }, []);

  const handleAuthFailure = useCallback((error) => {
    if (error instanceof AdminApiError && (error.status === 401 || error.code === "ADMIN_NOT_CONFIGURED")) {
      advanceSelection();
      setLocking(false);
      setUnlocked(false);
      setGateError(
        error.code === "ADMIN_NOT_CONFIGURED"
          ? "The content admin is not configured on this deployment."
          : "Your session ended. Sign in again."
      );
      return true;
    }
    return false;
  }, [advanceSelection]);

  const loadList = useCallback(
    async (name, { force = false } = {}) => {
      if (!name) return null;
      const selectedGeneration = selection.current;
      const requestId = (listRequest.current[name] || 0) + 1;
      listRequest.current[name] = requestId;
      setLists((current) => ({
        ...current,
        [name]: { ...(current[name] || {}), loading: true, error: "" },
      }));
      try {
        const data = await api.listDocuments(name);
        if (!isCurrentSelection(selectedGeneration) || listRequest.current[name] !== requestId) return null;
        const items = (Array.isArray(data?.documents) ? data.documents : [])
          .slice()
          .sort((left, right) => String(right._updatedAt || "").localeCompare(String(left._updatedAt || "")));
        setLists((current) => ({ ...current, [name]: { loading: false, error: "", items } }));
        setBanner((current) => current?.retry?.kind === "list" && current.retry.name === name ? null : current);
        if (force) referenceCache.current.delete(name);
        return items;
      } catch (error) {
        if (!isCurrentSelection(selectedGeneration) || listRequest.current[name] !== requestId) return null;
        if (!handleAuthFailure(error)) {
          setLists((current) => ({
            ...current,
            [name]: { ...(current[name] || {}), loading: false, error: error.message },
          }));
          setBanner({ tone: "error", text: error.message, retry: { kind: "list", name } });
        }
        return null;
      }
    },
    [api, handleAuthFailure, isCurrentSelection]
  );

  const loadReferenceOptions = useCallback(
    async (targets) => {
      const selectedGeneration = selection.current;
      const results = [];
      for (const target of targets) {
        if (!referenceCache.current.has(target)) {
          referenceCache.current.set(
            target,
            api.listDocuments(target).then((data) => {
              if (!isCurrentSelection(selectedGeneration)) throw Object.assign(new Error("The document changed."), { name: "AbortError" });
              return (data?.documents || []).map((entry) => ({
                _id: entry._id,
                _type: entry._type || target,
                title: entry.preview?.title || entry._id,
              }));
            })
          );
        }
        try {
          const options = await referenceCache.current.get(target);
          if (!isCurrentSelection(selectedGeneration)) throw Object.assign(new Error("The document changed."), { name: "AbortError" });
          results.push(...options);
        } catch (error) {
          if (isCurrentSelection(selectedGeneration)) referenceCache.current.delete(target);
          throw error;
        }
      }
      return results;
    },
    [api, isCurrentSelection]
  );

  const registerAsset = useCallback((ref, meta) => {
    if (isCurrentSelection(generation)) setAssets((current) => ({ ...current, [ref]: meta }));
  }, [generation, isCurrentSelection]);

  const captureEditTarget = useCallback(
    (path) => ({ sessionKey: sessionKeyRef.current, stablePath: toStablePath(workingRef.current, path) }),
    []
  );

  const applyAtTarget = useCallback((target, updater) => {
    if (!target?.sessionKey || target.sessionKey !== sessionKeyRef.current) return false;
    const path = resolveStablePath(workingRef.current, target.stablePath);
    if (!path) return false;
    setWorking((current) => {
      if (target.sessionKey !== sessionKeyRef.current) return current;
      const resolved = resolveStablePath(current, target.stablePath);
      return resolved ? setIn(current, resolved, updater(getIn(current, resolved))) : current;
    });
    return true;
  }, []);

  const beginUpload = useCallback(() => {
    if (isCurrentSelection(generation)) setUploadsInFlight((count) => count + 1);
  }, [generation, isCurrentSelection]);
  const endUpload = useCallback(() => {
    if (isCurrentSelection(generation)) setUploadsInFlight((count) => Math.max(0, count - 1));
  }, [generation, isCurrentSelection]);

  const confirmDiscard = () => {
    if (!editorState.current.dirty) return true;
    if (!window.confirm("You have unpublished changes. They are kept as a local draft on this device. Leave this document?")) return false;
    return flushDraft() || window.confirm("Your draft could not be saved in this browser. Leave and lose these edits?");
  };

  const resetEditorState = () => {
    setErrors([]);
    setConflict(null);
    setRecovery(null);
    setNotice("");
    setBanner(null);
    setHistoryOpen(false);
  };

  const openDocument = useCallback(
    async (documentId, { keepNotice = false } = {}) => {
      if (editorState.current.locking) return;
      const selectedGeneration = advanceSelection();
      setLoadingDocument(true);
      setSession(null);
      setWorking(null);
      setPane("editor");
      setErrors([]);
      setConflict(null);
      setRecovery(null);
      setHistoryOpen(false);
      if (!keepNotice) setNotice("");
      setBanner(null);
      try {
        const data = await api.getDocument(documentId);
        if (!isCurrentSelection(selectedGeneration)) return;
        const document = data?.document;
        if (!document || typeof document !== "object") throw new Error("The document could not be loaded.");
        const nextSession = {
          documentId,
          type: document._type,
          revision: data.revision,
          baseline: document,
          createIntentId: null,
        };
        setSession(nextSession);
        setWorking(document);
        setAssets(data.assets || {});
        setLoadVersion((version) => version + 1);
        const draft = readDraft(draftKey(nextSession));
        if (draft && stableJson(draft.document) !== stableJson(document)) {
          setRecovery({ draft, stale: draft.baseRevision !== data.revision });
        } else if (draft) {
          clearDraft(draftKey(nextSession));
        }
        setPane("editor");
      } catch (error) {
        if (!isCurrentSelection(selectedGeneration)) return;
        if (!handleAuthFailure(error)) setBanner({ tone: "error", text: error.message, retry: { kind: "document", documentId } });
      } finally {
        if (isCurrentSelection(selectedGeneration)) setLoadingDocument(false);
      }
    },
    [api, handleAuthFailure, isCurrentSelection, advanceSelection]
  );

  const startNewDocument = (name, resume = null) => {
    if (editorState.current.locking) return;
    advanceSelection();
    const createIntentId = resume?.createIntentId || newUuid();
    const defaults = { _type: name, ...createContentDefaults(name) };
    const nextSession = {
      documentId: null,
      type: name,
      revision: null,
      baseline: defaults,
      createIntentId,
    };
    resetEditorState();
    setSession(nextSession);
    setWorking(resume?.document || defaults);
    setAssets(resume?.assets || {});
    setLoadVersion((version) => version + 1);
    setPane("editor");
  };

  const selectType = async (name, { force = false } = {}) => {
    if (locking || (!force && name === typeName && pane !== "types")) return;
    if (!confirmDiscard()) return;
    const selectedGeneration = advanceSelection();
    setTypeName(name);
    setListFilter("");
    setSession(null);
    setWorking(null);
    resetEditorState();
    const selected = TYPES_BY_NAME.get(name);
    setPane(selected?.singleton ? "editor" : "documents");
    setLoadingDocument(Boolean(selected?.singleton));
    const items = await loadList(name);
    if (!isCurrentSelection(selectedGeneration)) return;
    setLoadingDocument(false);
    if (selected?.singleton && items) {
      const document = selected.fixedId ? items.find(item => item._id === selected.fixedId) : items[0];
      if (document) await openDocument(document._id);
      else startNewDocument(name, listNewDrafts(name)[0] || null);
    }
  };

  const unlock = async (event) => {
    event.preventDefault();
    const selectedGeneration = advanceSelection();
    setUnlocking(true);
    setGateError("");
    try {
      await api.signIn({ email, password });
      if (!isCurrentSelection(selectedGeneration)) return;
      setPassword("");
      setUnlocked(true);
    } catch (error) {
      if (!isCurrentSelection(selectedGeneration)) return;
      setGateError(
        error instanceof AdminApiError && error.status === 401
          ? "Email or password was not accepted."
          : error instanceof AdminApiError && error.code === "ADMIN_NOT_CONFIGURED"
            ? "The content admin is not configured on this deployment."
            : error instanceof AdminApiError && error.status === 429
              ? "Too many attempts. Wait a minute and try again."
              : error.message
      );
    } finally {
      if (isCurrentSelection(selectedGeneration)) setUnlocking(false);
    }
  };

  useEffect(() => {
    let active = true;
    const selectedGeneration = selection.current;
    api.getSession().then(data => { if (active && isCurrentSelection(selectedGeneration) && data.signedIn === true) setUnlocked(true); }).catch(error => {
      if (active && isCurrentSelection(selectedGeneration) && error.status !== 401) setGateError(error.code === "ADMIN_NOT_CONFIGURED" ? "The content admin is not configured on this deployment." : error.message);
    });
    return () => { active = false; };
  }, [api, isCurrentSelection]);

  const persistDraft = useCallback((key, draft) => {
    const saved = saveDraft(key, draft);
    setDraftError(saved ? "" : "Your draft could not be saved in this browser.");
    return saved;
  }, []);

  const flushDraft = useCallback(({ force = false } = {}) => {
    const current = editorState.current;
    if (!current.session || !current.working || (!current.dirty && !force)) return true;
    return persistDraft(current.currentDraftKey, {
      document: current.working,
      assets: current.assets,
      baseRevision: current.session.revision,
      createIntentId: current.session.createIntentId,
      documentId: current.session.documentId,
      type: current.session.type,
    });
  }, [persistDraft]);

  useEffect(() => {
    if (loadingDocument || !session || !working || !dirty || !currentDraftKey) return undefined;
    const timer = window.setTimeout(() => {
      if (!isCurrentSelection(generation)) return;
      flushDraft();
    }, 500);
    return () => window.clearTimeout(timer);
  }, [working, dirty, currentDraftKey, session, assets, flushDraft, loadingDocument, generation, isCurrentSelection]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || !window.matchMedia("(max-width: 1100px)").matches) return;
    if (workspace.getBoundingClientRect().top < 0) workspace.scrollIntoView({ block: "start" });
  }, [pane]);

  useEffect(() => {
    const handler = (event) => {
      if (!editorState.current.dirty) return;
      flushDraft();
      event.preventDefault();
      event.returnValue = "";
    };
    const pagehide = () => { flushDraft(); };
    window.addEventListener("beforeunload", handler);
    window.addEventListener("pagehide", pagehide);
    return () => {
      window.removeEventListener("beforeunload", handler);
      window.removeEventListener("pagehide", pagehide);
    };
  }, [flushDraft]);

  const errorsByPath = useMemo(
    () =>
      indexErrors(
        errors.map((error) => ({
          ...error,
          path: String(error?.path || "").replace(/^\$\.?/, ""),
        })),
        working
      ),
    [errors, working]
  );

  const editorContext = useMemo(
    () => ({ api, assets, registerAsset, loadReferenceOptions, errorsByPath, captureEditTarget, applyAtTarget, beginUpload, endUpload, baseline: session?.documentId ? baseline : null, document: working }),
    [api, assets, registerAsset, loadReferenceOptions, errorsByPath, captureEditTarget, applyAtTarget, beginUpload, endUpload, session?.documentId, baseline, working]
  );

  const finishPublication = async (pending, documentId) => {
    if (!isCurrentSelection(pending.generation)) return;
    clearDraft(draftKey(pending.session));
    setPendingPublication(null);
    referenceCache.current.delete(pending.session.type);
    const opening = openDocument(documentId);
    const publishedGeneration = selection.current;
    loadList(pending.session.type);
    await opening;
    if (isCurrentSelection(publishedGeneration)) setNotice(PUBLISH_NOTICE);
  };

  const notPublished = () => {
    setPendingPublication(null);
    setBanner({ tone: "error", text: "Not published. Retry when you are ready; your changes are kept as a local draft.", retry: { kind: "publish" } });
  };

  const reconcilePublication = async (pending) => {
    if (!pending || !isCurrentSelection(pending.generation)) return;
    setSaving(true);
    setBanner(null);
    try {
      let data;
      if (pending.session.documentId) data = await api.getDocument(pending.session.documentId);
      else {
        const receipt = await api.getCreateStatus(pending.session.type, pending.session.createIntentId, pending.document);
        if (!isCurrentSelection(pending.generation)) return;
        if (!hasCommittedCreateReceipt(receipt, pending.session)) { notPublished(); return; }
        data = { ...(await api.getDocument(receipt.documentId)), documentId: receipt.documentId, receipt };
      }
      if (!isCurrentSelection(pending.generation)) return;
      const documentId = pending.session.documentId || data?.documentId;
      if (!documentId || data?.document?._id !== documentId || data.document._type !== pending.session.type || typeof data.revision !== "string" || !data.revision || data.revision !== data.document._rev) {
        throw new Error("The publication status could not be read.");
      }
      if (publishedContentMatches(data, pending.session, pending.document, TYPES_BY_NAME.get(pending.session.type), pending.removedPaths)) {
        await finishPublication(pending, documentId);
      } else notPublished();
    } catch (error) {
      if (!isCurrentSelection(pending.generation) || handleAuthFailure(error)) return;
      if (error.status === 404) notPublished();
      else {
        setPendingPublication(pending);
        setBanner({ tone: "error", text: "Could not confirm publication. Your changes are kept as a local draft. Retry to check the saved version before publishing again.", retry: { kind: "publish-status" } });
      }
    } finally {
      if (isCurrentSelection(pending.generation)) setSaving(false);
    }
  };

  const publish = async () => {
    if (!session || !working || saving || pendingPublication || locking || loadingDocument || uploadsInFlight > 0) return;
    const selectedGeneration = selection.current;
    setNotice("");
    setBanner(null);
    setConflict(null);
    const validation = validateContentDocument(session.type, working, {
      current: session.documentId ? session.baseline : undefined,
    });
    if (!validation.ok) {
      setErrors(validation.errors);
      setBanner({ tone: "error", text: "Fix the highlighted fields before publishing.", summary: true });
      return;
    }
    setErrors([]);
    flushDraft({ force: true });
    setSaving(true);
    const submitted = working;
    const pending = { generation: selectedGeneration, session, document: submitted, removedPaths: session.documentId ? removedContentPaths(session.baseline, submitted, type) : [] };
    try {
      const body = session.documentId
        ? {
            operation: "replace",
            type: session.type,
            documentId: session.documentId,
            document: submitted,
            expectedRevision: session.revision,
          }
        : {
            operation: "create",
            type: session.type,
            createIntentId: session.createIntentId,
            document: submitted,
          };
      const result = await api.publish(body);
      if (!isCurrentSelection(selectedGeneration)) return;
      if (result?.committed !== true || typeof result.revision !== "string" || !result.revision || typeof result.documentId !== "string" || !result.documentId || (session.documentId && result.documentId !== session.documentId)) {
        throw new AdminApiError("The publication receipt could not be confirmed.", { code: "CMS_RECEIPT_INVALID" });
      }
      if (result.replayed === true) await reconcilePublication(pending);
      else await finishPublication(pending, result.documentId);
    } catch (error) {
      if (!isCurrentSelection(selectedGeneration) || handleAuthFailure(error)) return;
      if (error.code === "CMS_VALIDATION_FAILED" && Array.isArray(error.details)) {
        setErrors(error.details);
        setBanner({ tone: "error", text: "The server refused some fields. Fix them and publish again.", summary: true });
      } else if (["CMS_REVISION_CONFLICT", "CMS_CREATE_INTENT_CONFLICT"].includes(error.code)) {
        setConflict({ currentRevision: error.details?.currentRevision || null, documentId: error.details?.documentId || session.documentId });
      } else if (error.code === "CMS_SINGLETON_EXISTS") {
        setBanner({ tone: "error", text: "This section already exists. Reload the list and edit the existing one." });
      } else if (error.code === "CMS_WRITES_PAUSED") {
        setBanner({ tone: "warning", text: "Publishing is paused on this deployment. Your changes are kept as a local draft." });
      } else if (["ADMIN_REQUEST_TIMEOUT", "NETWORK_ERROR", "CMS_RECEIPT_INVALID"].includes(error.code) || error.status >= 500) {
        await reconcilePublication(pending);
      } else {
        setBanner({ tone: "error", text: `${error.message} Your changes are kept as a local draft.` });
      }
    } finally {
      if (isCurrentSelection(selectedGeneration)) setSaving(false);
    }
  };

  const deleteDocument = async () => {
    if (!session?.documentId || !type || type.singleton || saving || pendingPublication || locking || loadingDocument) return;
    const selectedGeneration = selection.current;
    const title = documentTitle(type, session.baseline);
    if (!window.confirm(`Delete “${title}” from the live site? It disappears from this list. A copy is kept in the database for recovery, but restoring it needs a developer.`)) return;
    setSaving(true);
    setBanner(null);
    try {
      await api.publish({
        operation: "delete",
        type: session.type,
        documentId: session.documentId,
        expectedRevision: session.revision,
      });
      if (!isCurrentSelection(selectedGeneration)) return;
      clearDraft(draftKey(session));
      referenceCache.current.delete(session.type);
      setSession(null);
      setWorking(null);
      setNotice("Deleted. The live site picks this up within a few minutes.");
      setPane("documents");
      loadList(session.type);
    } catch (error) {
      if (!isCurrentSelection(selectedGeneration) || handleAuthFailure(error)) return;
      if (error.code === "CMS_REFERENCED") {
        const referencedBy = Array.isArray(error.details?.referencedBy) ? error.details.referencedBy : [];
        setBanner({
          tone: "error",
          text: error.details?.reason || `This is still used by ${referencedBy.length || "other"} document${referencedBy.length === 1 ? "" : "s"}: ${referencedBy
            .map((entry) => entry.title || entry._id)
            .join(", ")}. Remove those references first.`,
        });
      } else if (["CMS_REVISION_CONFLICT", "CMS_CREATE_INTENT_CONFLICT"].includes(error.code)) {
        setConflict({ currentRevision: error.details?.currentRevision || null, documentId: error.details?.documentId || session.documentId });
      } else {
        setBanner({ tone: "error", text: error.message });
      }
    } finally {
      if (isCurrentSelection(selectedGeneration)) setSaving(false);
    }
  };

  const restoreRevision = ({ document, assets: revisionAssets, revision, documentId, selectionGeneration }) => {
    const current = editorState.current;
    if (!isCurrentSelection(selectionGeneration) || current.locking || current.pendingPublication || current.saving || current.session?.documentId !== documentId) return;
    if (current.dirty && !window.confirm("Replace your unpublished changes with this version? They will be lost.")) return;
    if (current.currentDraftKey) clearDraft(current.currentDraftKey);
    setWorking({ ...document, _id: current.session.baseline?._id ?? document._id, _type: current.session.type });
    setAssets((assets) => ({ ...assets, ...revisionAssets }));
    setLoadVersion((version) => version + 1);
    setHistoryOpen(false);
    setNotice(`Loaded the version that was live before ${displayTime(revision.createdAt)}. Publish to make it live again.`);
  };

  const finishSignOut = (error = "") => {
    setUnlocked(false);
    setGateError(error);
    setPassword("");
    setSession(null);
    setWorking(null);
    setLists({});
    setTypeName("");
    referenceCache.current.clear();
    resetEditorState();
    setPane("types");
  };

  const lock = async () => {
    if (locking || !confirmDiscard()) return;
    const selectedGeneration = advanceSelection();
    setLocking(true);
    try {
      await api.signOut();
      if (!isCurrentSelection(selectedGeneration)) return;
      finishSignOut();
    } catch (error) {
      if (!isCurrentSelection(selectedGeneration)) return;
      if (handleAuthFailure(error)) return;
      try {
        const status = await api.getSession();
        if (!isCurrentSelection(selectedGeneration)) return;
        if (status.signedIn === false) {
          finishSignOut(`${error.message} Your session is no longer active.`);
          return;
        }
      } catch (probeError) {
        if (!isCurrentSelection(selectedGeneration)) return;
        if (probeError.status === 401) {
          finishSignOut(`${error.message} Your session is no longer active.`);
          return;
        }
      }
      setBanner({ tone: "error", text: error.message, retry: { kind: "signout" } });
    } finally {
      if (isCurrentSelection(selectedGeneration)) setLocking(false);
    }
  };

  const retryFailure = () => {
    const retry = banner?.retry;
    if (retry?.kind === "list") selectType(retry.name, { force: true });
    else if (retry?.kind === "document") openDocument(retry.documentId);
    else if (retry?.kind === "signout") lock();
    else if (retry?.kind === "publish") publish();
    else if (retry?.kind === "publish-status") reconcilePublication(pendingPublication);
  };

  if (!unlocked) {
    return (
      <main id="main-content" tabIndex={-1} className={styles.shell}>
        <section className={styles.accessCard}>
          <div className={styles.iconBox}><KeyRound aria-hidden="true" /></div>
          <p className={styles.eyebrow}>Private admin</p>
          <h1>Site content</h1>
          <p className={styles.intro}>
            Sign in to edit packages, pages, FAQ, reviews, tools, coupons and policies.
          </p>
          <form className={styles.accessForm} onSubmit={unlock}>
            <label htmlFor="content-admin-email">Email</label>
            <input id="content-admin-email" type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} maxLength={254} required />
            <label htmlFor="content-admin-password">Password</label>
            <input id="content-admin-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} maxLength={128} required />
            <button type="submit" className={styles.primaryButton} disabled={unlocking || !email.trim() || !password}>
              {unlocking ? "Signing in…" : "Sign in"}
            </button>
          </form>
          {gateError ? <p className={styles.error} role="alert">{gateError}</p> : null}
        </section>
      </main>
    );
  }

  const list = lists[typeName] || {};
  const newDrafts = type && !type.singleton ? listNewDrafts(type.name) : [];
  const filterText = listFilter.trim().toLowerCase();
  const visibleItems = filterText
    ? (list.items || []).filter((entry) =>
        [entry.preview?.title, entry.preview?.subtitle, entry._id].some((value) =>
          String(value || "").toLowerCase().includes(filterText),
        ),
      )
    : list.items || [];
  const listHasImages = (list.items || []).some((entry) => entry.preview?.imageUrl);

  return (
    <main id="main-content" tabIndex={-1} className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Private admin</p>
          <h1>Site content</h1>
          <p className={styles.intro}>Edit what the site shows. Every publish is checked, versioned and goes straight to Supabase.</p>
        </div>
        <button type="button" className={styles.secondaryButton} onClick={lock} disabled={locking}>
          <Lock size={16} aria-hidden="true" /> Sign out
        </button>
      </header>

      {draftError ? <p className={styles.error} role="alert">{draftError}</p> : null}
      {banner && !banner.summary ? (
        <div className={banner.tone === "warning" ? styles.warningBox : styles.errorSummary} role="alert">
          <p>{banner.text}</p>
          {banner.retry ? <button type="button" className={styles.secondaryButton} onClick={retryFailure} disabled={saving || locking || loadingDocument}>Retry</button> : null}
        </div>
      ) : null}
      {["terms", "faqSection"].includes(typeName) ? <p className={styles.notice}>The Payments &amp; refunds and Cancellations sections, the Terms last-updated date and the money-back FAQ answer are managed in code and ignore edits here.</p> : null}
      {notice ? (
        <p className={styles.notice} role="status"><Check size={17} aria-hidden="true" />{notice}</p>
      ) : null}

      <div ref={workspaceRef} className={styles.workspace} data-pane={pane} data-singleton={!type || type.singleton ? "true" : "false"}>
        <nav className={styles.typePanel} aria-label="Content types">
          {GROUPS.map((group) => {
            const types = CONTENT_TYPES.filter((entry) => entry.group === group.id && !["footer", "siteSettings"].includes(entry.name));
            if (types.length === 0) return null;
            return (
              <div key={group.id} className={styles.typeGroup}>
                <p className={styles.groupTitle}>{group.title}</p>
                {types.map((entry) => (
                  <button
                    key={entry.name}
                    type="button"
                    className={entry.name === typeName ? styles.typeActive : styles.typeButton}
                    aria-current={entry.name === typeName ? "page" : undefined}
                    onClick={() => selectType(entry.name)}
                    disabled={locking}
                  >
                    <span>{entry.title}</span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                ))}
              </div>
            );
          })}
        </nav>

        {type && !type.singleton ? (
          <section className={styles.documentPanel} aria-label={`${type.title} list`}>
            <div className={styles.panelHeader}>
              <button type="button" className={styles.backButton} onClick={() => setPane("types")}>
                <ArrowLeft size={16} aria-hidden="true" /> Types
              </button>
              <div className={styles.panelTitle}>
                <h2>{type.title}</h2>
                {list.items ? (
                  <span className={styles.countTag}>
                    {filterText ? `${visibleItems.length} of ${list.items.length}` : list.items.length}
                  </span>
                ) : null}
              </div>
              {list.items && list.items.length > 8 ? (
                <label className={styles.searchBox}>
                  <Search size={16} aria-hidden="true" />
                  <input
                    type="search"
                    aria-label={`Filter ${type.title.toLowerCase()}`}
                    placeholder="Filter by title"
                    value={listFilter}
                    onChange={(event) => setListFilter(event.target.value)}
                  />
                </label>
              ) : null}
              <div className={styles.panelActions}>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Refresh list"
                  title="Refresh list"
                  onClick={() => loadList(type.name, { force: true })}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={styles.primaryButtonSmall}
                  onClick={() => {
                    if (confirmDiscard()) startNewDocument(type.name);
                  }}
                >
                  <FilePlus2 size={16} aria-hidden="true" /> New
                </button>
              </div>
            </div>
            {newDrafts.length > 0 ? (
              <div className={styles.draftList}>
                <p className={styles.groupTitle}>Unpublished drafts on this device</p>
                {newDrafts.map((draft) => (
                  <button
                    key={draft.key}
                    type="button"
                    className={styles.documentButton}
                    onClick={() => {
                      if (confirmDiscard()) startNewDocument(type.name, draft);
                    }}
                  >
                    <span>
                      <strong>{documentTitle(type, draft.document, "New draft")}</strong>
                      <small>Saved {displayTime(draft.savedAt)}</small>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className={styles.documentList}>
              {list.loading && !list.items ? (
                <>
                  <span className={styles.visuallyHidden} role="status">Loading…</span>
                  {[0, 1, 2, 3].map((index) => <span key={index} className={styles.skeletonRow} aria-hidden="true" />)}
                </>
              ) : null}
              {list.items && list.items.length === 0 ? <p className={styles.muted}>Nothing here yet. Use New to create the first one.</p> : null}
              {list.items && list.items.length > 0 && visibleItems.length === 0 ? (
                <p className={styles.muted}>No titles match “{listFilter.trim()}”.</p>
              ) : null}
              {visibleItems.map((entry) => (
                <button
                  key={entry._id}
                  type="button"
                  className={entry._id === session?.documentId ? styles.documentActive : styles.documentButton}
                  onClick={() => {
                    if (entry._id !== session?.documentId && confirmDiscard()) openDocument(entry._id);
                    else if (entry._id === session?.documentId) setPane("editor");
                  }}
                >
                  {entry.preview?.imageUrl ? (
                    <img src={entry.preview.imageUrl} alt="" loading="lazy" />
                  ) : listHasImages ? (
                    <span className={styles.thumbPlaceholder} aria-hidden="true"><ImageIcon size={18} /></span>
                  ) : null}
                  <span>
                    <strong>{entry.preview?.title || entry._id}</strong>
                    {entry.preview?.subtitle ? <small>{entry.preview.subtitle}</small> : null}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section className={styles.editorPanel} aria-label="Editor" aria-busy={loadingDocument}>
          {!type ? (
            <div className={styles.emptyState}>
              <div className={styles.iconBox}><LayoutList aria-hidden="true" /></div>
              <h2>Choose what to edit</h2>
              <p>Pick a section on the left. Drafts save on this device as you type, and nothing goes live until you publish.</p>
            </div>
          ) : !session || !working ? (
            <div className={styles.emptyState}>
              <button type="button" className={styles.backButton} onClick={() => setPane(type.singleton ? "types" : "documents")}>
                <ArrowLeft size={16} aria-hidden="true" /> {type.singleton ? "Types" : type.title}
              </button>
              <h2>{loadingDocument ? "Loading…" : type.title}</h2>
              {!loadingDocument && !type.singleton ? <p>Choose an entry from the list, or create a new one.</p> : null}
            </div>
          ) : (
            <EditorContext.Provider value={editorContext}>
              <div className={styles.editorHeader}>
                <button
                  type="button"
                  className={styles.backButton}
                  onClick={() => setPane(type.singleton ? "types" : "documents")}
                >
                  <ArrowLeft size={16} aria-hidden="true" /> {type.singleton ? "Types" : type.title}
                </button>
                <div>
                  <p className={styles.eyebrow}>{type.title}</p>
                  <h2>{documentTitle(type, working, type.singleton ? type.title : session.documentId ? "Untitled" : "New")}</h2>
                  <p className={styles.statusLine}>
                    {session.documentId ? "Published" : "Not published yet"}
                    {dirty ? <span className={styles.dirtyTag}>Unpublished changes</span> : null}
                  </p>
                  {type.description ? <p className={styles.fieldHelp}>{type.description}</p> : null}
                </div>
                <div className={styles.editorActions}>
                  {session.documentId ? (
                    <button type="button" className={styles.secondaryButton} onClick={() => setHistoryOpen((open) => !open)} disabled={saving || pendingPublication || locking || loadingDocument}>
                      <History size={16} aria-hidden="true" /> History
                    </button>
                  ) : null}
                  {session.documentId && !type.singleton ? (
                    <button type="button" className={styles.secondaryButtonDanger} onClick={deleteDocument} disabled={saving || pendingPublication || locking || loadingDocument}>
                      <Trash2 size={16} aria-hidden="true" /> Delete
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={publish}
                    disabled={saving || pendingPublication || locking || loadingDocument || uploadsInFlight > 0 || type.fields.every(field => field.readOnly) || (!dirty && Boolean(session.documentId))}
                    title={uploadsInFlight > 0 ? "Wait for the upload to finish" : undefined}
                  >
                    <Save size={16} aria-hidden="true" />
                    {saving ? "Publishing…" : uploadsInFlight > 0 ? "Uploading…" : "Publish"}
                  </button>
                </div>
              </div>

              {recovery ? (
                <div className={recovery.stale ? styles.warningBox : styles.infoBox} role="status">
                  <AlertTriangle size={18} aria-hidden="true" />
                  <div>
                    <strong>Unpublished changes from {displayTime(recovery.draft.savedAt)} are saved on this device.</strong>
                    <p>
                      {recovery.stale
                        ? "This document was published again since then. Restoring puts your older edits over the latest version."
                        : "Restore them to keep working, or discard them."}
                    </p>
                    <div className={styles.inlineGroup}>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => {
                          setWorking(recovery.draft.document);
                          setAssets((current) => ({ ...current, ...(recovery.draft.assets || {}) }));
                          setLoadVersion((version) => version + 1);
                          setRecovery(null);
                        }}
                      >
                        Restore my changes
                      </button>
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => {
                          clearDraft(draftKey(session));
                          setRecovery(null);
                        }}
                      >
                        Discard them
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {conflict ? (
                <div className={styles.warningBox} role="alert">
                  <AlertTriangle size={18} aria-hidden="true" />
                  <div>
                    <strong>Someone published a newer version while you were editing.</strong>
                    <p>Nothing was overwritten. Load the latest version, then restore your saved draft if you still want those changes.</p>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => {
                        const targetId = conflict.documentId || session.documentId;
                        const key = session.documentId ? draftKey(session) : draftKey({ documentId: targetId });
                        const saved = persistDraft(key, {
                          document: working,
                          assets,
                          baseRevision: session.revision,
                          createIntentId: session.documentId ? session.createIntentId : null,
                          documentId: targetId,
                          type: session.type,
                        });
                        if (!saved && !window.confirm("Your draft could not be saved on this device. Load the latest version and lose your edits?")) return;
                        if (!session.documentId) clearDraft(draftKey(session));
                        openDocument(targetId);
                      }}
                    >
                      Load latest version
                    </button>
                  </div>
                </div>
              ) : null}

              {banner?.summary && errors.length === 0 ? (
                <p className={banner.tone === "warning" ? styles.warningLine : styles.error} role="alert">{banner.text}</p>
              ) : null}

              {errors.length > 0 ? (
                <div className={styles.errorSummary} role="alert">
                  <strong>{banner?.summary ? banner.text : "Fix the highlighted fields before publishing."}</strong>
                  <span>{errors.length} field{errors.length === 1 ? "" : "s"} need attention</span>
                  <ul>
                    {errors.slice(0, 12).map((error, index) => (
                      <li key={index}>
                        <strong>{contentErrorLabel(type, error.path)}:</strong> {error.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className={styles.editorBody}>
                <form
                  key={`${session.documentId || session.createIntentId}:${loadVersion}`}
                  className={styles.form}
                  inert={saving || pendingPublication || loadingDocument || locking ? true : undefined}
                  aria-busy={Boolean(saving || pendingPublication || loadingDocument || locking)}
                  onSubmit={(event) => {
                    event.preventDefault();
                    publish();
                  }}
                >
                  <ObjectFields
                    fields={type.fields}
                    path={[]}
                    value={working}
                    onChange={(next) => setWorking(next)}
                  />
                </form>
                {historyOpen && session.documentId ? (
                  <RevisionHistory
                    api={api}
                    documentId={session.documentId}
                    selectionGeneration={generation}
                    isCurrentSelection={isCurrentSelection}
                    onRestore={restoreRevision}
                    onClose={() => setHistoryOpen(false)}
                  />
                ) : null}
              </div>
            </EditorContext.Provider>
          )}
        </section>
      </div>
    </main>
  );
}
