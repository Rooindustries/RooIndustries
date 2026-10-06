begin transaction read only;
set local statement_timeout='30s';
select 'commerce_mirror_outbox' outbox,status,count(*) rows_to_retire from migration.commerce_mirror_outbox where status in ('pending','retry','processing') group by status union all select 'document_mutation_mirror_outbox',status,count(*) from migration.document_mutation_mirror_outbox where status in ('pending','retry','processing') group by status order by 1,2;
rollback;
