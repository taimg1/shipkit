-- The rows the e2e run tests against.
--
-- The kit mounts this file into the database service before it starts; the image runs it on
-- first boot. Nothing in the kit reads it, and nothing generates it: an empty database answers
-- every query with no rows, so /orders would render an empty list, return 200, and pass any
-- test that only checked the status code. The data a suite asserts on is the project's to state.

create table orders (
  id        integer primary key,
  reference text not null
);

insert into orders (id, reference) values
  (1, 'SK-1001'),
  (2, 'SK-1002');
