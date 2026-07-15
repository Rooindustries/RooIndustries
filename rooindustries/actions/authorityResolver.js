import {
  GLOBAL_OPERATIONAL_DOCUMENT_TYPES,
  GLOBAL_REFERRAL_DOCUMENT_TYPES,
  globalCmsAuthorityDomain,
} from '../../src/lib/globalCmsContract.js'

const NATIVE_MUTATION_ACTIONS = new Set([
  'delete',
  'discardChanges',
  'duplicate',
  'publish',
  'restore',
  'unpublish',
])
const BLOCKED_NEW_DOCUMENT_TYPES = new Set([
  ...GLOBAL_OPERATIONAL_DOCUMENT_TYPES,
  ...GLOBAL_REFERRAL_DOCUMENT_TYPES,
])
const HOSTED_FILE_ACCEPT =
  '.zip,.exe,application/zip,application/x-zip-compressed,application/octet-stream,application/vnd.microsoft.portable-executable,application/x-msdownload'

export const resolveGlobalDocumentActions = (previous, context, replacements) => {
  const domain = globalCmsAuthorityDomain(context?.schemaType)
  if (!domain) return previous
  if (domain === 'operational') return []
  if (domain === 'referral') return [replacements.referral]

  const remaining = previous.filter((action) => !NATIVE_MUTATION_ACTIONS.has(action?.action))
  return [...remaining, replacements.publish, replacements.unpublish, replacements.delete]
}

export const filterGlobalNewDocumentOptions = (previous, {writesPaused = false} = {}) =>
  writesPaused
    ? []
    : previous.filter(
        (option) =>
          !BLOCKED_NEW_DOCUMENT_TYPES.has(option?.templateId) &&
          !BLOCKED_NEW_DOCUMENT_TYPES.has(option?.schemaType),
      )

export const globalStructureTypes = (schemaTypes) =>
  schemaTypes.filter((schemaType) => !GLOBAL_OPERATIONAL_DOCUMENT_TYPES.includes(schemaType.name))

export const makeGlobalSchemas = (schemaTypes, {writesPaused = false} = {}) =>
  schemaTypes.map((schemaType) => {
    const normalizedSchema =
      schemaType.name === 'tool'
        ? {
            ...schemaType,
            fields: schemaType.fields.map((field) =>
              field.name === 'downloadFile'
                ? {...field, options: {...field.options, accept: HOSTED_FILE_ACCEPT}}
                : field,
            ),
          }
        : schemaType
    if (!writesPaused && !BLOCKED_NEW_DOCUMENT_TYPES.has(schemaType.name)) {
      return normalizedSchema
    }
    return {
      ...normalizedSchema,
      fields: normalizedSchema.fields.map((field) => ({...field, readOnly: true})),
    }
  })

export const cmsSourceRevision = ({operation, document, published, draft}) =>
  String(operation === 'publish' ? document?._rev || '' : published?._rev || draft?._rev || '')

export const cmsValidationDocumentId = ({id, draft, published}) =>
  String(draft?._id || published?._id || id || '')

export const cmsPublishValidationState = ({operation, document, validation}) => {
  const errors = (validation?.validation || []).filter((marker) => marker?.level === 'error')
  const pending =
    operation === 'publish' &&
    (validation?.isValidating === true || validation?.revision !== document?._rev)
  return {errors, pending}
}

export const shouldCleanCmsDraft = ({operation, hasDraft, syncPending}) =>
  operation !== 'unpublish' && hasDraft === true && syncPending !== true
