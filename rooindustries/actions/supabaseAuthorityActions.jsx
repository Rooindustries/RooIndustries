import {useCallback, useMemo, useState} from 'react'
import {useClient, useValidationStatus} from 'sanity'
import {
  GLOBAL_SANITY_DATASET,
  GLOBAL_SANITY_PROJECT_ID,
  collectGlobalCmsAssetIds,
  publishedDocumentId,
  resolveCmsWritePauseFlag,
} from '../../src/lib/globalCmsContract.js'
import {
  cmsPublishValidationState,
  cmsSourceRevision,
  cmsValidationDocumentId,
  shouldCleanCmsDraft,
} from './authorityResolver.js'

const API_URL =
  import.meta.env.SANITY_STUDIO_CMS_API_URL || 'https://www.rooindustries.com/api/admin/cms-publish'
const REFERRAL_ADMIN_URL =
  import.meta.env.SANITY_STUDIO_REFERRAL_ADMIN_URL ||
  'https://www.rooindustries.com/admin/referrals'
const STUDIO_WRITE_CONTROL = resolveCmsWritePauseFlag(
  import.meta.env.SANITY_STUDIO_CMS_WRITES_PAUSED,
)
const ASSET_QUERY =
  '*[_id in $ids]{_id,_type,assetId,extension,url,mimeType,size,sha1hash,metadata{dimensions{width,height}}}'

const messageForResult = (operation, syncPending, draftCleanupPending) => {
  if (draftCleanupPending) {
    return 'Saved in Supabase. The Sanity draft still needs cleanup.'
  }
  if (syncPending) return 'Saved in Supabase. The Sanity backup is still syncing.'
  if (operation === 'delete') return 'Deleted from Supabase and synchronized to Sanity.'
  if (operation === 'unpublish') return 'Unpublished in Supabase and synchronized to Sanity.'
  return 'Published to Supabase and synchronized to Sanity.'
}

const commandError = async (response) => {
  const payload = await response.json().catch(() => ({}))
  const error = new Error(payload?.error || 'Publishing is temporarily unavailable.')
  error.code = String(payload?.code || '')
  return error
}

const asDraftDocument = (document, draftId) => {
  const {_createdAt, _rev, _updatedAt, ...business} = document
  return {...business, _id: draftId}
}

const deleteDraftAtRevision = async ({client, draftId, revision}) => {
  const result = await client.delete(
    {
      query: '*[_id == $id && _rev == $revision]',
      params: {id: draftId, revision},
    },
    {returnDocuments: false, returnFirst: false},
  )
  return Array.isArray(result?.documentIds) && result.documentIds.includes(draftId)
}

const resolvePublishedId = (value) => {
  try {
    return publishedDocumentId(value)
  } catch {
    return ''
  }
}

const writeControlMessage = () =>
  STUDIO_WRITE_CONTROL.configured
    ? 'CMS writes are temporarily paused.'
    : 'CMS writes are paused because the Studio write control is unavailable.'

const writeControlLabel = () =>
  STUDIO_WRITE_CONTROL.configured ? 'CMS writes paused' : 'CMS write control unavailable'

const useAuthorityAction = (props, operation) => {
  const client = useClient({apiVersion: '2026-07-01'})
  const validationDocumentId = cmsValidationDocumentId(props)
  const validation = useValidationStatus(validationDocumentId, props.type, true)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState(null)
  const publishedId = useMemo(() => resolvePublishedId(props.id), [props.id])
  const draftId = publishedId ? `drafts.${publishedId}` : ''
  const document = props.draft || props.published
  const isPublish = operation === 'publish'
  const missingDocument = isPublish && !document
  const writeControlBlocked = !STUDIO_WRITE_CONTROL.configured || STUDIO_WRITE_CONTROL.paused
  const validationState = cmsPublishValidationState({operation, document, validation})
  const disabled =
    writeControlBlocked ||
    busy ||
    !publishedId ||
    missingDocument ||
    validationState.pending ||
    (isPublish && validationState.errors.length > 0)

  const execute = useCallback(async () => {
    setBusy(true)
    setDialog(null)
    try {
      if (writeControlBlocked) throw new Error(writeControlMessage())
      if (!publishedId)
        throw new Error('Release documents cannot be published through this action.')
      const token = String(client.config().token || '')
      if (!token) throw new Error('Sign in to Sanity Studio again before publishing.')

      if (operation === 'unpublish' && props.published && !props.draft) {
        await client.createIfNotExists(asDraftDocument(props.published, draftId))
      }

      const assetIds = isPublish ? collectGlobalCmsAssetIds(document) : []
      const assetManifest = assetIds.length
        ? await client.fetch(ASSET_QUERY, {ids: assetIds}, {perspective: 'raw'})
        : []
      const response = await globalThis.fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectId: GLOBAL_SANITY_PROJECT_ID,
          dataset: GLOBAL_SANITY_DATASET,
          operation,
          type: props.type,
          documentId: publishedId,
          document: isPublish ? document : null,
          sourceRevision: cmsSourceRevision({operation, document, ...props}),
          assetManifest,
        }),
      })
      if (!response.ok) {
        const error = await commandError(response)
        if (
          operation === 'delete' &&
          !props.published &&
          props.draft &&
          error.code === 'CMS_AUTHORITY_MISSING'
        ) {
          const deleted = await deleteDraftAtRevision({
            client,
            draftId,
            revision: props.draft._rev,
          })
          if (!deleted) throw new Error('The draft changed before it could be deleted.')
          props.onComplete()
          return
        }
        throw error
      }
      const result = await response.json()
      let draftCleanupPending = false
      if (
        shouldCleanCmsDraft({
          operation,
          hasDraft: Boolean(props.draft),
          syncPending: result.syncPending,
        })
      ) {
        try {
          const deleted = await deleteDraftAtRevision({
            client,
            draftId,
            revision: props.draft._rev,
          })
          if (!deleted) draftCleanupPending = true
        } catch {
          draftCleanupPending = true
        }
      }
      setDialog({
        type: 'dialog',
        header: 'Supabase content saved',
        content: messageForResult(operation, result.syncPending === true, draftCleanupPending),
        onClose: () => {
          setDialog(null)
          props.onComplete()
        },
      })
    } catch (error) {
      setDialog({
        type: 'dialog',
        header: 'Publishing failed',
        content: error instanceof Error ? error.message : 'Publishing failed.',
        onClose: () => setDialog(null),
      })
    } finally {
      setBusy(false)
    }
  }, [client, document, draftId, isPublish, operation, props, publishedId, writeControlBlocked])

  return {busy, dialog, disabled, execute, writeControlBlocked}
}

export const SupabasePublishAction = (props) => {
  const action = useAuthorityAction(props, 'publish')
  return {
    action: 'supabasePublish',
    label: action.writeControlBlocked
      ? writeControlLabel()
      : action.busy
        ? 'Publishing…'
        : 'Publish to Supabase',
    disabled: action.disabled,
    onHandle: action.execute,
    dialog: action.dialog,
  }
}

export const SupabaseUnpublishAction = (props) => {
  const action = useAuthorityAction(props, 'unpublish')
  const [confirming, setConfirming] = useState(false)
  return {
    action: 'supabaseUnpublish',
    label: action.writeControlBlocked
      ? writeControlLabel()
      : action.busy
        ? 'Unpublishing…'
        : 'Unpublish from Supabase',
    disabled: action.disabled || (!props.published && !props.draft),
    onHandle: action.writeControlBlocked ? action.execute : () => setConfirming(true),
    dialog:
      action.dialog ||
      (confirming
        ? {
            type: 'confirm',
            tone: 'caution',
            message: 'Unpublish this document from Supabase and keep its draft?',
            onCancel: () => setConfirming(false),
            onConfirm: () => {
              setConfirming(false)
              action.execute()
            },
          }
        : null),
    tone: 'caution',
  }
}

export const SupabaseDeleteAction = (props) => {
  const action = useAuthorityAction(props, 'delete')
  const [confirming, setConfirming] = useState(false)
  return {
    action: 'supabaseDelete',
    label: action.writeControlBlocked
      ? writeControlLabel()
      : action.busy
        ? 'Deleting…'
        : 'Delete from Supabase',
    disabled: action.disabled || (!props.published && !props.draft),
    onHandle: action.writeControlBlocked ? action.execute : () => setConfirming(true),
    dialog:
      action.dialog ||
      (confirming
        ? {
            type: 'confirm',
            tone: 'critical',
            message: 'Delete this document from Supabase and its Sanity backup?',
            onCancel: () => setConfirming(false),
            onConfirm: () => {
              setConfirming(false)
              action.execute()
            },
          }
        : null),
    tone: 'critical',
  }
}

export const ReferralAdminAction = (props) => ({
  action: 'referralAdmin',
  label: 'Manage in referral admin',
  onHandle: () => {
    globalThis.open(REFERRAL_ADMIN_URL, '_blank', 'noopener,noreferrer')
    props.onComplete()
  },
})
