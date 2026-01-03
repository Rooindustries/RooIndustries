export default {
  name: 'upgradeLink',
  title: 'Upgrade Links',
  type: 'document',
  fields: [
    {
      name: 'title',
      title: 'Link Title',
      type: 'string',
      description: 'Shown as the page heading.',
      validation: (Rule) => Rule.required(),
    },
    {
      name: 'slug',
      title: 'Link Slug',
      type: 'slug',
      options: {
        source: 'title',
        slugify: (input) =>
          input
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^\w-]+/g, '')
            .slice(0, 60),
      },
      description: 'Use in URL: rooindustries/upgrade/<link that you put in the field down here>',
      validation: (Rule) => Rule.required(),
    },
    {
      name: 'targetPackage',
      title: 'Upgrade To Package',
      type: 'reference',
      to: [{type: 'package'}],
      validation: (Rule) => Rule.required(),
    },
    {
      name: 'intro',
      title: 'Short Intro Text',
      type: 'text',
      rows: 3,
      description: 'short line shown under the heading if u want.',
    },
  ],
  preview: {
    select: {
      title: 'title',
      packageTitle: 'targetPackage.title',
      slug: 'slug.current',
    },
    prepare({title, packageTitle, slug}) {
      return {
        title: title || 'Upgrade Link',
        subtitle: [packageTitle, slug ? `/${slug}` : ''].filter(Boolean).join(' - '),
      }
    },
  },
}
