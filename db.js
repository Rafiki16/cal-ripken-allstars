const path = require('path');
const fs = require('fs');

const ROSTER = [
  ['Miguel Cardenas',       'Major', 'DeVittori',                     11, 'Rosa Robledo',       '9419619200'],
  ['Graeme Thompson',       'Major', 'Dreamers',                      11, 'Matt Thompson',      '9413026510'],
  ['Quinn Kabrick',         'Major', 'Dreamers',                      11, 'Lauren Kabrick',     '2243305966'],
  ['Elizabeth Garcia',      'Major', 'Dreamers',                      11, 'Rosa Garcia',        '6095565279'],
  ['Connor Mundella',       'Major', 'Fresco AC Heating & Cooling',   11, 'Heather Mundella',   '9417401813'],
  ['George Griffith',       'Major', 'Sunrise Drainage',              11, 'Kevin Griffith',     '9418067653'],
  ['Keiryn Lacy',           'Major', 'Brick Pavers',                  12, 'Tanjee Lane',        '9415394454'],
  ['Luke Najjar',           'Major', 'Fresco AC Heating & Cooling',   12, 'Jeff Najjar',        '8136955673'],
  ['Levi Collins',          'Major', 'Fresco AC Heating & Cooling',   12, 'April Johns',        '9415440428'],
  ['Bennett Lansdale',      'Major', 'Sunrise Drainage',              12, 'Miranda Lansdale',   '2399860105'],
  ['Jake Shallenberger',    'Major', 'Sunrise Drainage',              12, 'Liz Shallenberger',  '9173346435'],
  ['Austin James Pepper',   'Major', 'Sunrise Drainage',              12, 'Alexander Pepper',   '9419007649'],
];

let impl;

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        player_name TEXT NOT NULL,
        division TEXT NOT NULL,
        team TEXT NOT NULL,
        age INTEGER NOT NULL,
        parent_name TEXT NOT NULL,
        parent_phone TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        updated_at TIMESTAMPTZ
      )
    `);

    const { rows } = await pool.query('SELECT COUNT(*) as c FROM players');
    if (parseInt(rows[0].c) === 0) {
      for (const r of ROSTER) {
        await pool.query(
          'INSERT INTO players (player_name, division, team, age, parent_name, parent_phone) VALUES ($1,$2,$3,$4,$5,$6)',
          r
        );
      }
    }

    impl = {
      getAllPlayers: async () => (await pool.query('SELECT * FROM players ORDER BY age, player_name')).rows,
      getPlayersByPhone: async (phone) => (await pool.query('SELECT * FROM players WHERE parent_phone = $1', [phone])).rows,
      getPlayer: async (id) => (await pool.query('SELECT * FROM players WHERE id = $1', [id])).rows[0] || null,
      updateStatus: async (id, status) => pool.query('UPDATE players SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]),
    };
  } else {
    const Database = require('better-sqlite3');
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
    const sqliteDb = new Database(path.join(dataDir, 'allstars.db'));
    sqliteDb.pragma('journal_mode = WAL');

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_name TEXT NOT NULL,
        division TEXT NOT NULL,
        team TEXT NOT NULL,
        age INTEGER NOT NULL,
        parent_name TEXT NOT NULL,
        parent_phone TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        updated_at TEXT
      )
    `);

    const count = sqliteDb.prepare('SELECT COUNT(*) as c FROM players').get();
    if (count.c === 0) {
      const insert = sqliteDb.prepare('INSERT INTO players (player_name,division,team,age,parent_name,parent_phone) VALUES (?,?,?,?,?,?)');
      const insertMany = sqliteDb.transaction((rows) => { for (const r of rows) insert.run(...r); });
      insertMany(ROSTER);
    }

    impl = {
      getAllPlayers: async () => sqliteDb.prepare('SELECT * FROM players ORDER BY age, player_name').all(),
      getPlayersByPhone: async (phone) => sqliteDb.prepare('SELECT * FROM players WHERE parent_phone = ?').all(phone),
      getPlayer: async (id) => sqliteDb.prepare('SELECT * FROM players WHERE id = ?').get(id) || null,
      updateStatus: async (id, status) => sqliteDb.prepare('UPDATE players SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id),
    };
  }
}

module.exports = {
  init,
  getAllPlayers: (...args) => impl.getAllPlayers(...args),
  getPlayersByPhone: (...args) => impl.getPlayersByPhone(...args),
  getPlayer: (...args) => impl.getPlayer(...args),
  updateStatus: (...args) => impl.updateStatus(...args),
};
