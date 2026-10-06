begin transaction read only;
set local statement_timeout='30s';
select jsonb_build_object('utf8_required',current_setting('server_encoding')='UTF8','icu_root_case_mapping_required',to_regcollation('pg_catalog."und-x-icu"') is not null,'document_writer_present',to_regprocedure('public.roo_apply_document_mutations(jsonb)') is not null,'commerce_writer_present',to_regprocedure('migration.roo_apply_commerce_document_mutations_unbounded(text,jsonb,integer)') is not null,'cms_commerce_writer_present',to_regprocedure('migration.apply_cms_commerce_mutation(text,jsonb)') is not null);
rollback;
