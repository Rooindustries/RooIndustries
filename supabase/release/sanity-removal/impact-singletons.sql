begin transaction read only;
set local statement_timeout='30s';
select document_type,count(*) live_count,count(*) filter(where document_type='bookingSettings' and legacy_sanity_id<>'6d8a3646-0ed2-44b5-ad45-c5c9d578126a') wrong_fixed_id_count from migration.source_documents where not tombstoned and document_type in ('about','bookingSettings','contact','discordBanner','faqSettings','footer','hero','howItWorks','meetTheTeam','packagesSettings','privacyPolicy','proReviewsCarousel','referralBox','services','siteSettings','supportedGames','terms') group by document_type having count(*)>1 or count(*) filter(where document_type='bookingSettings' and legacy_sanity_id<>'6d8a3646-0ed2-44b5-ad45-c5c9d578126a')>0 order by document_type;
rollback;
