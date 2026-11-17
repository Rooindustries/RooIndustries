set lock_timeout = '5s';
set statement_timeout = '120s';

drop function if exists public.roo_record_cms_image_sizes(text, jsonb);
drop function if exists public.roo_cms_image_size_records(text, integer);

notify pgrst, 'reload schema';
