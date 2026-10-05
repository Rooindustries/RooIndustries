begin transaction isolation level repeatable read read only;
set local statement_timeout='30s';
with sources as materialized (
 select legacy_sanity_id,document_type,payload from migration.source_documents
 where not tombstoned and document_type in ('paymentRecord','booking')
), arrays as (
 select legacy_sanity_id,document_type,
 case when document_type='booking' then jsonb_build_array(payload->'currency',payload->'bookingPayload'->'currency')
 else jsonb_build_array(payload->'pricingSnapshot'->'currency',payload->'bookingPayload'->'currency',payload->'providerPublicData'->'currency',payload->'refundCurrency')
   ||coalesce((select jsonb_agg(refund->'currency') from jsonb_array_elements(case when jsonb_typeof(payload->'refunds')='array' then payload->'refunds' else '[]'::jsonb end) refund),'[]'::jsonb)
 end as currency_values from sources
), values_with_order as (
 select a.legacy_sanity_id,a.document_type,e.ordinality,
 e.value,case when jsonb_typeof(e.value)='string' then upper(btrim(e.value#>>'{}')) end as code,
 e.value<>'null'::jsonb and (jsonb_typeof(e.value)<>'string' or btrim(e.value#>>'{}')<>'') as explicit_present
 from arrays a cross join lateral jsonb_array_elements(a.currency_values) with ordinality e(value,ordinality)
), first_codes as (
 select legacy_sanity_id,document_type,(array_agg(code order by ordinality) filter(where code~'^[A-Z]{3}$'))[1] as first_code,
 min(ordinality) filter(where value<>'null'::jsonb and (jsonb_typeof(value)<>'string' or (code<>'' and code!~'^[A-Z]{3}$'))) as first_invalid,
 bool_or(explicit_present) as explicit_present
 from values_with_order group by legacy_sanity_id,document_type
), mismatches as (
 select f.legacy_sanity_id,f.document_type,f.first_code,f.first_invalid,f.explicit_present,
 min(v.ordinality) filter(where v.code~'^[A-Z]{3}$' and v.code<>f.first_code) as first_mismatch
 from first_codes f join values_with_order v using(legacy_sanity_id,document_type)
 group by f.legacy_sanity_id,f.document_type,f.first_code,f.first_invalid,f.explicit_present
), classified as (
 select *,case when first_invalid is not null and (first_mismatch is null or first_invalid<first_mismatch) then 'payment_currency_invalid'
 when first_mismatch is not null then 'payment_currency_mismatch' end as reason,
 coalesce(first_code,'USD') as resolved_currency from mismatches
), payment_results as (
 select s.legacy_sanity_id,case when c.explicit_present then c.reason when upper(btrim(coalesce(booking.currency,'')))<>'' and upper(btrim(booking.currency))!~'^[A-Z]{3}$' then 'payment_currency_invalid' end as reason,
 case when c.explicit_present then c.resolved_currency else coalesce(nullif(upper(btrim(booking.currency)),''),'USD') end as resolved_currency
 from sources s join classified c using(legacy_sanity_id,document_type)
 left join commerce.bookings booking on booking.legacy_sanity_id=nullif(s.payload->>'bookingId','')
 where s.document_type='paymentRecord'
), booking_links as (
 select booking.legacy_sanity_id as booking_id,payment.legacy_sanity_id as payment_id,payment_class.reason,
 case when payment_class.explicit_present then payment_class.resolved_currency else booking_class.resolved_currency end as resolved_currency
 from sources booking join classified booking_class on booking_class.legacy_sanity_id=booking.legacy_sanity_id and booking_class.document_type='booking'
 join sources payment on payment.document_type='paymentRecord' and (payment.legacy_sanity_id=nullif(booking.payload->>'paymentRecordId','') or payment.payload->>'bookingId'=booking.legacy_sanity_id)
 join payment_results payment_result on payment_result.legacy_sanity_id=payment.legacy_sanity_id
 join classified payment_class on payment_class.legacy_sanity_id=payment.legacy_sanity_id and payment_class.document_type='paymentRecord'
 where booking.document_type='booking'
), booking_final_codes as (
 select c.legacy_sanity_id as booking_id,v.code from classified c join values_with_order v using(legacy_sanity_id,document_type)
 where c.document_type='booking' and c.reason is null and v.code~'^[A-Z]{3}$'
 union all select link.booking_id,link.resolved_currency from booking_links link
 join classified c on c.legacy_sanity_id=link.booking_id and c.document_type='booking'
 where c.reason is null and link.reason is null
), results as (
 select 'paymentRecord'::text as document_type,p.legacy_sanity_id,p.reason from payment_results p
 union all select 'booking',c.legacy_sanity_id,c.reason from classified c where c.document_type='booking' and c.reason is not null
 union all select distinct 'booking',c.legacy_sanity_id,link.reason from classified c join booking_links link on link.booking_id=c.legacy_sanity_id
 where c.document_type='booking' and c.reason is null and link.reason is not null
 union all select 'booking',c.legacy_sanity_id,case when (select count(distinct code) from booking_final_codes where booking_id=c.legacy_sanity_id)>1 then 'payment_currency_mismatch' end
 from classified c where c.document_type='booking' and c.reason is null and not exists(select 1 from booking_links link where link.booking_id=c.legacy_sanity_id and link.reason is not null)
)
select document_type,coalesce(reason,'valid') as reason,count(*) as source_rows
from results group by document_type,reason order by document_type,reason nulls last;
rollback;
