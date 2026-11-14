CREATE TABLE machines (
  machine TEXT PRIMARY KEY NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE told (
  down INTEGER NOT NULL,
  twice INTEGER NOT NULL
);
INSERT INTO told (down, twice) VALUES (0, 0);
