-- A player is assigned to one of the season's game nights; goalies stop having
-- a table of their own.
--
-- Leagues that play more than one night a week have players who only ever play
-- one of them. That was expressible for goalies alone, through a table nobody
-- else could use, and it is now a column on the roster row: any player may
-- carry a night, and for a goalie it is what makes them that night's starter.
--
-- ⛔ THIS DROPS `team_goalie_days` AND `is_default_goalie`, AND THE CONVERSION
-- ABOVE THE DROPS IS THE ONLY THING THAT CARRIES THEM FORWARD. Measured against
-- production on 2026-09-11: 6 goalie-day rows (all in the old-boys league) and
-- 3 default flags. All three flags sit on teams with exactly ONE goalie, which
-- the replacement rule "one rostered goalie => that goalie" reproduces — so the
-- flags convert to nothing on purpose, not by omission. See
-- `src/lib/goalie/suggest.ts`, which is the whole of that rule and is tested.
--
-- ⚠️ A PLAYER HOLDING TWO DAY ROWS KEEPS NO NIGHT. One team's goalie is listed
-- on both Mon and Thu and is that team's ONLY goalie; "no fixed night" is the
-- truthful description of playing every night, and the one-goalie rule covers
-- them. That is what `having count(*) = 1` is for — it is not a tie-break.

alter table seasons
  add column game_nights smallint[] not null default '{}';

comment on column seasons.game_nights is
  'Weekdays this season plays, 0=Sun..6=Sat. Declared by generateSchedule from the manager''s weekday checkboxes, NOT derived from the games — deriving it would make the league appear to play Saturdays the moment one game moved to a Saturday.';

alter table team_players
  add column night_of_week smallint
    check (night_of_week between 0 and 6);

comment on column team_players.night_of_week is
  'The night of the week this player plays, 0=Sun..6=Sat, or null for no fixed night. For a goalie it names that night''s starter.';

-- ⛔ NO UNIQUE CONSTRAINT, UNLIKE THE TABLE THIS REPLACES. `team_goalie_days`
-- was unique on (team, season, day); reproducing that would refuse a team that
-- genuinely alternates two goalies on one night. `suggestGoalie` breaks the tie
-- deterministically instead, by lowest jersey.

-- Convert: only a player with exactly one day row takes a night.
update team_players tp
   set night_of_week = gd.day_of_week
  from (
    select player_id, team_id, season_id, min(day_of_week) as day_of_week
      from team_goalie_days
     group by player_id, team_id, season_id
    having count(*) = 1
  ) gd
 where tp.player_id = gd.player_id
   and tp.team_id   = gd.team_id
   and tp.season_id = gd.season_id;

-- Backfill the nights each season actually plays, from its published games, so
-- no season that already exists starts out with nothing declared.
update seasons s
   set game_nights = g.nights
  from (
    select season_id,
           -- ⛔ NO `order by` IN THIS AGGREGATE. `array_agg(DISTINCT expr ORDER
           -- BY 1)` is a hard error — 42P10, "in an aggregate with DISTINCT,
           -- ORDER BY expressions must appear in argument list": inside an
           -- aggregate a bare `1` is a constant, not a positional reference.
           -- Measured 2026-09-11 by running it against production. DISTINCT
           -- sorts on its own, which is where the ordering comes from.
           array_agg(distinct extract(dow from
             (scheduled_at at time zone 'America/New_York'))::smallint) as nights
      from games
     where not is_draft and scheduled_at is not null
     group by season_id
  ) g
 where g.season_id = s.id;

-- ⚠️ `supabase db reset` CANNOT EXERCISE THE BACKFILL, so do not read a green
-- reset as evidence it works. Migrations run against an empty database and the
-- seed loads afterwards, so there are no games here to read and every season
-- comes out `{}` — the seed sets its own value for that reason. The statement
-- above was verified two ways on 2026-09-11: run read-only against PRODUCTION,
-- where it returns {2} for the executive league and {1,4} for the old boys; and
-- run against the local database AFTER seeding, where it returns sorted arrays
-- as expected.
--
-- ⚠️ AND IT IS CLOCK-DEPENDENT AGAINST THE SEED, which is the other reason the
-- seed declares its nights rather than leaning on this. The seed's "tonight"
-- fixture is always today, so a suite run on a Friday derives a Friday into the
-- league's nights and one run on a Tuesday does not.

drop table team_goalie_days;
alter table team_players drop column is_default_goalie;
