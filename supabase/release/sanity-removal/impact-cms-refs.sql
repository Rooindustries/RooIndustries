begin transaction read only;
set local statement_timeout='30s';
select source.document_type,source.legacy_sanity_id,refs.field_path,refs.ref
from migration.source_documents source
cross join lateral migration.cms_nested_refs(source.payload) refs
where not source.tombstoned
  and source.document_type not in ('bookingSettings','coupon','upgradeLink','couponRedemption')
  and refs.ref is not null
  and refs.ref !~ '^(image|file)-'
order by source.document_type,source.legacy_sanity_id,refs.field_path,refs.ref;
rollback;
