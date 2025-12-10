export default {
  name: 'tool',
  title: 'Tool',
  type: 'document',
  fields: [
    {
      name: 'title',
      title: 'Tool Name',
      type: 'string',
      validation: (Rule) => Rule.required(),
    },
    {
      name: 'sortOrder',
      title: 'Sort Order',
      type: 'number',
      description: 'Lower number = appears earlier in the list',
    },

    {
      name: 'category',
      title: 'Category',
      type: 'string',
      description:
        'Type any label you want (e.g. Monitoring, Benchmarks, Overclocking, RAM, BIOS, etc.)',
    },

    {
      name: 'shortDescription',
      title: 'Short Description',
      type: 'text',
      rows: 3,
      description: 'A brief line about what this tool is used for.',
    },

    {
      name: 'icon',
      title: 'Icon',
      type: 'image',
      options: {hotspot: true},
      description: 'Small square logo for the card.',
    },

    // ---- DOWNLOAD MODE + CONDITIONAL FIELDS ----
    {
      name: 'downloadMode',
      title: 'Download Mode',
      type: 'string',
      options: {
        list: [
          {title: 'Official / External link', value: 'external'},
          {title: 'Hosted file on Roo', value: 'hosted'},
        ],
        layout: 'radio',
      },
      initialValue: 'external',
      validation: (Rule) => Rule.required(),
    },

    {
      name: 'downloadUrl',
      title: 'External Download URL',
      type: 'url',
      description: 'Used when mode = external (e.g. CPUID download link).',
      hidden: ({parent}) => parent?.downloadMode !== 'external',
      validation: (Rule) =>
        Rule.custom((value, context) => {
          const mode = context.parent?.downloadMode
          if (mode === 'external' && !value) {
            return 'Download URL is required when mode is "Official / External link".'
          }
          return true
        }),
    },

    {
      name: 'downloadFile',
      title: 'Hosted Installer / ZIP',
      type: 'file',
      description:
        'Upload the installer if you want to serve it directly from Roo (used when mode = hosted).',
      hidden: ({parent}) => parent?.downloadMode !== 'hosted',
      validation: (Rule) =>
        Rule.custom((value, context) => {
          const mode = context.parent?.downloadMode
          if (mode === 'hosted' && !value) {
            return 'Hosted file is required when mode is "Hosted file on Roo".'
          }
          return true
        }),
    },

    {
      name: 'officialSite',
      title: 'Official Website',
      type: 'url',
      description: 'Main site for the tool, if you want a separate Official Site button.',
    },

    {
      name: 'downloadNote',
      title: 'Download Note',
      type: 'string',
      description:
        'e.g."Download from official CPUID mirror" or "Installer hosted directly by Roo Industries."',
    },
  ],
}
