import sanityClient from '@sanity/client'

export const client = sanityClient({
  projectId: '9g42k3ur', // public
  dataset: 'production', // public
  apiVersion: '2023-10-01',
  useCdn: true, // fast reads
})
