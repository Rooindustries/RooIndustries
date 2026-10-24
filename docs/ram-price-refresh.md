# Homepage RAM price

The homepage compares one specific 32GB (2x16GB) DDR5-6000 kit with Performance
Vertex Max. It is a quoted retail example, not a claim about the cheapest kit or
the whole market. The source link names v-color and shows the UTC date checked.
Tax and shipping are excluded. The tune price uses the same package record and
price presentation as the packages page.

## Source

The source is v-color's official Shopify Storefront API, version 2026-07, in
US/USD context. Product `8511039242407`, variant `46736066052263`, SKU
`TMXFL1660830KWK`. The query checks all three identities, the capacity and speed,
currency, country, availability, backorder status and source URL.

[Shopify documents tokenless product queries](https://shopify.dev/docs/api/storefront/2026-07#tokenless-access)
and [automated API traffic](https://shopify.dev/docs/api/storefront/2026-07#rate-limits).
[v-color's terms, section 12(i)](https://v-color.net/policies/terms-of-service)
prohibit “to spam, phish, pharm, pretext, spider, crawl, or scrape”. This job uses
the documented API and does not scrape pages, create carts or submit orders.

## Refresh and failure behavior

Vercel calls `/api/content/ram-price/refresh` at minute 17 every six hours (UTC).
It uses the existing `CRON_SECRET` and Supabase server credential. Anonymous
requests are refused before database or source access. A durable database limit
admits one attempt per six-hour UTC window across all instances, including failed
attempts. A successful quote is reused for the rest of its window.

An accepted amount is $25 through $1,500 and no more than 30% above or below the
last verified quote. The source response must be no more than 15 minutes old,
no more than five minutes ahead, and have no cache age above five minutes.
Malformed, unavailable, mismatched, stale or implausible responses keep the old
price and its original date. A failed refresh reports a warning through the
existing server reporting hook. No price or provider response is sent with it.

Only `hero.ramPrice` is replaced through the existing CMS command. The command
checks the loaded revision. One conflict retry reloads the editor's latest
document; all their other fields survive. A lost publish response is read back
before retrying. The cron revalidates the homepage, not a deployment. Existing
CMS history retains each successful quote for inspection and rollback.

## Local proof

`npm run test:ram-price`
starts the site's existing isolated fixture server. Storefront and CMS responses
are synthetic; the Next route and CMS command are real. The network guard refuses
external traffic. Production refuses fixture source configuration and rejects a
CI process. The fixture server uses no production credentials.

After the reviewed deployment, call the cron with the existing credential once
to seed the first quote, then check the homepage, its source link and Markdown.
Do not insert a guessed or copied price if the source fails.
