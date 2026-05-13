export default {
  name: 'siteSettings',
  title: 'Site Control',
  type: 'document',
  fields: [
    {
      name: 'siteMode',
      title: 'Site Mode',
      type: 'string',
      initialValue: 'maintenance',
      options: {
        layout: 'radio',
        direction: 'horizontal',
        list: [
          {title: 'Site Maintenance', value: 'maintenance'},
          {title: 'Site Live', value: 'live'},
        ],
      },
      validation: (Rule) => Rule.required(),
    },
  ],
  preview: {
    select: {
      siteMode: 'siteMode',
    },
    prepare: ({siteMode}) => ({
      title: 'Site Control',
      subtitle:
        siteMode === 'live' ? 'Site Live' : 'Site Maintenance',
    }),
  },
}
