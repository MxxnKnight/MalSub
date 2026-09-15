create table if not exists titles (
  id serial primary key,
  source_id text not null,
  title text not null,
  url text not null,
  year integer,
  kind text not null default 'movie',
  poster text,
  fetched_at timestamptz not null default now(),
  unique (source_id, url)
);

create index if not exists titles_source_idx on titles (source_id);
create index if not exists titles_title_lower_idx on titles (source_id, lower(title));

create table if not exists catalog_fetches (
  id serial primary key,
  source_id text not null,
  ok boolean not null,
  count integer not null default 0,
  note text,
  ms integer not null default 0,
  fetched_at timestamptz not null default now()
);
