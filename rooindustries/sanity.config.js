import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {visionTool} from '@sanity/vision'
import {schemaTypes} from './schemaTypes'
import {resolveCmsWritePauseFlag} from '../src/lib/globalCmsContract'
import {
  filterGlobalNewDocumentOptions,
  globalStructureTypes,
  makeGlobalSchemas,
  resolveGlobalDocumentActions,
} from './actions/authorityResolver'
import {
  ReferralAdminAction,
  SupabaseDeleteAction,
  SupabasePublishAction,
  SupabaseUnpublishAction,
} from './actions/supabaseAuthorityActions'

const baseConfig = {
  projectId: '9g42k3ur',
  plugins: [visionTool()],
}

const globalWriteControl = resolveCmsWritePauseFlag(import.meta.env.SANITY_STUDIO_CMS_WRITES_PAUSED)
const globalWritesPaused = !globalWriteControl.configured || globalWriteControl.paused
const globalSchemaTypes = makeGlobalSchemas(schemaTypes, {writesPaused: globalWritesPaused})
const globalVisibleTypes = new Set(globalStructureTypes(globalSchemaTypes).map((type) => type.name))

export default defineConfig([
  {
    ...baseConfig,
    name: 'global',
    title: 'Roo Industries Global',
    basePath: '/global',
    dataset: 'production',
    plugins: [
      structureTool({
        structure: (builder) =>
          builder
            .list()
            .title('Roo Industries Global')
            .items(
              builder
                .documentTypeListItems()
                .filter((item) => globalVisibleTypes.has(item.getId())),
            ),
      }),
      visionTool(),
    ],
    schema: {types: globalSchemaTypes},
    document: {
      actions: (previous, context) =>
        resolveGlobalDocumentActions(previous, context, {
          publish: SupabasePublishAction,
          unpublish: SupabaseUnpublishAction,
          delete: SupabaseDeleteAction,
          referral: ReferralAdminAction,
        }),
      newDocumentOptions: (previous) =>
        filterGlobalNewDocumentOptions(previous, {writesPaused: globalWritesPaused}),
    },
  },
  {
    ...baseConfig,
    name: 'india',
    title: 'Roo Industries India',
    basePath: '/india',
    dataset: 'production-in',
    plugins: [structureTool(), visionTool()],
    schema: {types: schemaTypes},
  },
])
