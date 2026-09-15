alter table titles add column if not exists season integer;
alter table titles add column if not exists series_title text;
create index if not exists titles_series_idx on titles (source_id, series_title, season);
