-- Enum types used across the schema.
create type app_role as enum ('league_manager', 'captain', 'scorekeeper');
create type player_position as enum ('F', 'D', 'G');
create type game_status as enum ('scheduled', 'in_progress', 'final', 'postponed', 'cancelled');
create type game_type as enum ('regular', 'playoff');
create type result_type as enum ('regulation', 'overtime', 'shootout');
create type strength as enum ('EV', 'PP', 'SH', 'EN');
create type penalty_class as enum ('minor', 'major', 'misconduct');
