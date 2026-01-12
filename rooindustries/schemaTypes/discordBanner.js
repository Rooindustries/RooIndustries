export default {
  name: 'discordBanner',
  title: 'Discord Banner',
  type: 'document',
  fields: [
    {
      name: 'text',
      title: 'Banner Text',
      type: 'string',
      initialValue: 'Free optimization guide in our Discord',
    },
    {
      name: 'mobileText',
      title: 'Mobile Text',
      type: 'string',
      initialValue: 'Free guide in Discord',
    },
    {
      name: 'link',
      title: 'Link',
      type: 'url',
      initialValue: 'https://discord.gg/M7nTkn9dxE',
    },
  ],
}
