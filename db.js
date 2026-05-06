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

const PROFILE_COLS = [
  'parent_email TEXT',
  'birthdate TEXT',
  'best_positions TEXT',
  'favorite_positions TEXT',
  'arm_strength INTEGER',
  'throwing_accuracy INTEGER',
  'contact_hitting INTEGER',
  'power_hitting INTEGER',
  'pitching INTEGER',
  'infield_defense INTEGER',
  'outfield_defense INTEGER',
  'catcher_skill INTEGER',
  'baseball_iq INTEGER',
  'profile_updated_at TEXT',
  'contacts TEXT',
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

    for (const col of PROFILE_COLS) {
      const colName = col.split(' ')[0];
      try { await pool.query(`ALTER TABLE players ADD COLUMN ${col}`); } catch (e) { /* exists */ }
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'Coach',
        phone TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL DEFAULT 'unavailable',
        start_date TEXT NOT NULL,
        end_date TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
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
      updateProfile: async (id, data) => {
        await pool.query(`
          UPDATE players SET birthdate=$1, best_positions=$2, favorite_positions=$3,
            arm_strength=$4, throwing_accuracy=$5, contact_hitting=$6, power_hitting=$7,
            pitching=$8, infield_defense=$9, outfield_defense=$10, catcher_skill=$11,
            baseball_iq=$12, contacts=$13, profile_updated_at=NOW()
          WHERE id=$14`,
          [data.birthdate, data.best_positions, data.favorite_positions,
           data.arm_strength, data.throwing_accuracy, data.contact_hitting, data.power_hitting,
           data.pitching, data.infield_defense, data.outfield_defense, data.catcher_skill,
           data.baseball_iq, data.contacts, id]
        );
      },
      addPlayer: async (p) => {
        await pool.query(
          'INSERT INTO players (player_name, division, team, age, parent_name, parent_phone, parent_email) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [p.player_name, p.division, p.team, p.age, p.parent_name, p.parent_phone, p.parent_email || null]
        );
      },
      removePlayer: async (id) => pool.query('DELETE FROM players WHERE id = $1', [id]),
      getAllStaff: async () => (await pool.query('SELECT * FROM staff ORDER BY name')).rows,
      getStaffByPhone: async (phone) => (await pool.query('SELECT * FROM staff WHERE phone = $1', [phone])).rows[0] || null,
      addStaff: async (s) => pool.query('INSERT INTO staff (name, role, phone) VALUES ($1,$2,$3)', [s.name, s.role, s.phone]),
      removeStaff: async (id) => pool.query('DELETE FROM staff WHERE id = $1', [id]),
      getPlayerEvents: async (playerId) => (await pool.query('SELECT * FROM events WHERE player_id = $1 ORDER BY start_date', [playerId])).rows,
      getAllEvents: async () => (await pool.query('SELECT * FROM events ORDER BY start_date')).rows,
      addEvent: async (e) => pool.query('INSERT INTO events (player_id, event_type, start_date, end_date, notes) VALUES ($1,$2,$3,$4,$5)', [e.player_id, e.event_type, e.start_date, e.end_date, e.notes]),
      removeEvent: async (id) => pool.query('DELETE FROM events WHERE id = $1', [id]),
      getAdminByUsername: async (username) => (await pool.query('SELECT * FROM admins WHERE username = $1', [username])).rows[0] || null,
      getAdminById: async (id) => (await pool.query('SELECT * FROM admins WHERE id = $1', [id])).rows[0] || null,
      getAllAdmins: async () => (await pool.query('SELECT id, username, created_at FROM admins ORDER BY created_at')).rows,
      countAdmins: async () => parseInt((await pool.query('SELECT COUNT(*) as c FROM admins')).rows[0].c),
      createAdmin: async (username, passwordHash) => pool.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', [username, passwordHash]),
      updateAdminPassword: async (id, passwordHash) => pool.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [passwordHash, id]),
      removeAdmin: async (id) => pool.query('DELETE FROM admins WHERE id = $1', [id]),
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

    for (const col of PROFILE_COLS) {
      try { sqliteDb.exec(`ALTER TABLE players ADD COLUMN ${col}`); } catch (e) { /* exists */ }
    }

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS staff (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'Coach',
        phone TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL DEFAULT 'unavailable',
        start_date TEXT NOT NULL,
        end_date TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
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
      updateProfile: async (id, data) => {
        sqliteDb.prepare(`
          UPDATE players SET birthdate=?, best_positions=?, favorite_positions=?,
            arm_strength=?, throwing_accuracy=?, contact_hitting=?, power_hitting=?,
            pitching=?, infield_defense=?, outfield_defense=?, catcher_skill=?,
            baseball_iq=?, contacts=?, profile_updated_at=?
          WHERE id=?`
        ).run(
          data.birthdate, data.best_positions, data.favorite_positions,
          data.arm_strength, data.throwing_accuracy, data.contact_hitting, data.power_hitting,
          data.pitching, data.infield_defense, data.outfield_defense, data.catcher_skill,
          data.baseball_iq, data.contacts, new Date().toISOString(), id
        );
      },
      addPlayer: async (p) => {
        sqliteDb.prepare('INSERT INTO players (player_name, division, team, age, parent_name, parent_phone, parent_email) VALUES (?,?,?,?,?,?,?)')
          .run(p.player_name, p.division, p.team, p.age, p.parent_name, p.parent_phone, p.parent_email || null);
      },
      removePlayer: async (id) => sqliteDb.prepare('DELETE FROM players WHERE id = ?').run(id),
      getAllStaff: async () => sqliteDb.prepare('SELECT * FROM staff ORDER BY name').all(),
      getStaffByPhone: async (phone) => sqliteDb.prepare('SELECT * FROM staff WHERE phone = ?').get(phone) || null,
      addStaff: async (s) => sqliteDb.prepare('INSERT INTO staff (name, role, phone) VALUES (?,?,?)').run(s.name, s.role, s.phone),
      removeStaff: async (id) => sqliteDb.prepare('DELETE FROM staff WHERE id = ?').run(id),
      getPlayerEvents: async (playerId) => sqliteDb.prepare('SELECT * FROM events WHERE player_id = ? ORDER BY start_date').all(playerId),
      getAllEvents: async () => sqliteDb.prepare('SELECT * FROM events ORDER BY start_date').all(),
      addEvent: async (e) => sqliteDb.prepare('INSERT INTO events (player_id, event_type, start_date, end_date, notes) VALUES (?,?,?,?,?)').run(e.player_id, e.event_type, e.start_date, e.end_date, e.notes),
      removeEvent: async (id) => sqliteDb.prepare('DELETE FROM events WHERE id = ?').run(id),
      getAdminByUsername: async (username) => sqliteDb.prepare('SELECT * FROM admins WHERE username = ?').get(username) || null,
      getAdminById: async (id) => sqliteDb.prepare('SELECT * FROM admins WHERE id = ?').get(id) || null,
      getAllAdmins: async () => sqliteDb.prepare('SELECT id, username, created_at FROM admins ORDER BY created_at').all(),
      countAdmins: async () => sqliteDb.prepare('SELECT COUNT(*) as c FROM admins').get().c,
      createAdmin: async (username, passwordHash) => sqliteDb.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, passwordHash),
      updateAdminPassword: async (id, passwordHash) => sqliteDb.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(passwordHash, id),
      removeAdmin: async (id) => sqliteDb.prepare('DELETE FROM admins WHERE id = ?').run(id),
    };
  }
}

module.exports = {
  init,
  getAllPlayers: (...args) => impl.getAllPlayers(...args),
  getPlayersByPhone: (...args) => impl.getPlayersByPhone(...args),
  getPlayer: (...args) => impl.getPlayer(...args),
  updateStatus: (...args) => impl.updateStatus(...args),
  updateProfile: (...args) => impl.updateProfile(...args),
  addPlayer: (...args) => impl.addPlayer(...args),
  removePlayer: (...args) => impl.removePlayer(...args),
  getAllStaff: (...args) => impl.getAllStaff(...args),
  getStaffByPhone: (...args) => impl.getStaffByPhone(...args),
  addStaff: (...args) => impl.addStaff(...args),
  removeStaff: (...args) => impl.removeStaff(...args),
  getPlayerEvents: (...args) => impl.getPlayerEvents(...args),
  getAllEvents: (...args) => impl.getAllEvents(...args),
  addEvent: (...args) => impl.addEvent(...args),
  removeEvent: (...args) => impl.removeEvent(...args),
  getAdminByUsername: (...args) => impl.getAdminByUsername(...args),
  getAdminById: (...args) => impl.getAdminById(...args),
  getAllAdmins: (...args) => impl.getAllAdmins(...args),
  countAdmins: (...args) => impl.countAdmins(...args),
  createAdmin: (...args) => impl.createAdmin(...args),
  updateAdminPassword: (...args) => impl.updateAdminPassword(...args),
  removeAdmin: (...args) => impl.removeAdmin(...args),
};
