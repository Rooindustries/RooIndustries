set lock_timeout = '5s';
set statement_timeout = '120s';

alter function public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb,text)
  set statement_timeout = '120s';
