set lock_timeout = '5s';
set statement_timeout = '120s';

begin;

alter table tourney.email_dispatches
  drop constraint if exists email_dispatches_dispatch_kind_check,
  add constraint email_dispatches_dispatch_kind_check
    check (
      dispatch_kind in (
        'registration',
        'approval',
        'reset',
        'discord_invite',
        'appeal',
        'payout',
        'feedback'
      )
    );

commit;
