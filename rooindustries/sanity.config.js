import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {visionTool} from '@sanity/vision'
import {schemaTypes} from './schemaTypes'

const baseConfig = {
  projectId: '9g42k3ur',
  plugins: [structureTool(), visionTool()],
  schema: {
    types: schemaTypes,
  },
}

export default defineConfig([
  {
    ...baseConfig,
    name: 'global',
    title: 'Roo Industries Global',
    dataset: 'production',
  },
  {
    ...baseConfig,
    name: 'india',
    title: 'Roo Industries India',
    dataset: 'production-in',
  },
])
