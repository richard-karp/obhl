-- The monogram chip `TeamLogo` draws for a team with no logo image painted its
-- letters white and nothing else. A team whose colour is pale — white, yellow,
-- sky — therefore had an unreadable chip on every page it appeared on, and the
-- only fix available was to change the team's colour.
--
-- Stored per team rather than derived from the colour's luminance: whoever
-- picked the colour can see which of the two inks reads better against it, and
-- a computed threshold gets the borderline cases wrong with no way to overrule
-- it. Two named choices rather than a free colour, because this is which of the
-- chip's two legible inks to use — not a third colour to co-ordinate with the
-- other two.
--
-- Defaulting to 'light' keeps every team that exists today looking exactly as it
-- does today; the column changes nothing until someone flips it.
--
-- No RLS work here, and that is a decision rather than an omission. `teams`
-- already has row level security enabled (0008) and a `manager write teams`
-- policy (0009), and RLS is per table, so the new column is governed by the
-- policy that is already there. The blanket
-- `grant insert, update, delete on all tables in schema public` in 0009 only
-- bites a NEW table that forgets `enable row level security` — this is a column
-- on an existing one, so that hazard does not apply.
alter table teams
  add column logo_text_color text not null default 'light'
    check (logo_text_color in ('light', 'dark'));

comment on column teams.logo_text_color is
  'Ink for the TeamLogo monogram chip when the team has no logo image: ''light'' (white letters) or ''dark''. Has no effect once logo_path is set — that branch renders the uploaded image and no letters.';
