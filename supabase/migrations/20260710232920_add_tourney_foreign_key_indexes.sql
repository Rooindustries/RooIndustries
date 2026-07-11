create index if not exists tourney_player_tokens_player_id_idx
  on tourney.tourney_player_tokens (player_id);

create index if not exists tourney_bracket_team_members_team_id_idx
  on tourney.tourney_bracket_team_members (team_id);
