set lock_timeout = '5s';
set statement_timeout = '120s';

drop trigger source_documents_require_commerce_lock_for_payment_hold on migration.source_documents;
drop function migration.require_commerce_lock_for_payment_hold_document();
