begin transaction read only;
set local statement_timeout='30s';
select legacy_sanity_id,payload#>>'{slug,current}' slug from migration.source_documents where not tombstoned and document_type='upgradeLink' and coalesce(payload#>>'{slug,current}','') !~ '^[A-Za-z0-9-]{1,80}$' order by legacy_sanity_id;
rollback;
