export default {
  name: 'packagesSettings',
  title: 'Packages Section',
  type: 'document',
  fields: [
    {
      name: 'heading',
      title: 'Heading',
      type: 'string',
      description: 'Main heading above the packages list.',
    },
    {
      name: 'badgeText',
      title: 'Badge Text',
      type: 'string',
      description: 'Small pill text shown under the heading.',
    },
    {
      name: 'subheading',
      title: 'Subheading',
      type: 'text',
      rows: 2,
      description: 'Short line under the badge.',
    },
  ],
}
