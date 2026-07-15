# Roo Industries Content Studio

Global publish, unpublish, and delete actions write through the Roo Industries
CMS API with Supabase as the authority and Sanity as the rollback projection.
The India workspace keeps its existing native Sanity behavior.

Set `SANITY_STUDIO_CMS_WRITES_PAUSED` to an explicit `0` or `1` for every Studio
build. It must match the website runtime's `CMS_WRITES_PAUSED` value. A missing,
invalid, or enabled Studio value disables all global authority actions.

For a rollback pause, deploy both values as `1`, verify the commerce readiness
response reports `cms_writes_paused`, and leave India unchanged. Resume global
CMS writes only by deploying both values as `0` and verifying the readiness
control reports `matches=true` and `globalCmsReady=true`.
