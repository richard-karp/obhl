-- Atomic increment/decrement for empty-net goals against, matching the pattern
-- of bump_game_roster_stat. Floors at 0 so decrements can't go negative.
create or replace function public.bump_game_empty_net(
  p_game uuid,
  p_side text,  -- 'home' or 'away'
  p_delta int   -- +1 or -1
) returns void language plpgsql security invoker set search_path = public as $$
begin
  if p_side = 'home' then
    update games
       set home_empty_net_against = greatest(0, home_empty_net_against + p_delta)
     where id = p_game;
  elsif p_side = 'away' then
    update games
       set away_empty_net_against = greatest(0, away_empty_net_against + p_delta)
     where id = p_game;
  end if;
end;
$$;

grant execute on function public.bump_game_empty_net(uuid, text, int) to authenticated;
