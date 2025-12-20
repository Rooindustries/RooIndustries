export default {
  name: 'packageBullet',
  title: 'Package Bullet (Global)',
  type: 'document',
  fields: [
    {
      name: 'label',
      title: 'Bullet Label',
      type: 'string',
      description: 'One of the 6 shared bullet points (same across all packages).',
      validation: (Rule) => Rule.required().max(80),
    },
    {
      name: 'order',
      title: 'Display Order',
      type: 'number',
      description: 'Controls bullet ordering (1 shows first).',
      initialValue: 1,
      validation: (Rule) => Rule.integer().min(1).max(6),
    },
  ],
}
