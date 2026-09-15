alter table titles add column if not exists subtitle_url text;
alter table titles add column if not exists lastmod text;

alter table catalog_fetches add column if not exists inserted integer not null default 0;
alter table catalog_fetches add column if not exists updated integer not null default 0;
