CREATE TABLE bottles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id   TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'drifting',
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  beached_at  TEXT,
  launched_at TEXT NOT NULL,
  simulated_to TEXT NOT NULL,
  distance_km REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_bottles_beached ON bottles(status, lat, lon);

CREATE TABLE tokens (
  token      TEXT PRIMARY KEY,
  bottle_id  INTEGER NOT NULL REFERENCES bottles(id),
  role       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_tokens_bottle ON tokens(bottle_id);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bottle_id  INTEGER NOT NULL REFERENCES bottles(id),
  content    TEXT NOT NULL,
  lat REAL, lon REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_bottle ON messages(bottle_id);

CREATE TABLE track_points (
  bottle_id  INTEGER NOT NULL,
  ts         TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  PRIMARY KEY (bottle_id, ts)
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
