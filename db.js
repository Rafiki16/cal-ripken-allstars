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

    try { await pool.query('ALTER TABLE staff ADD COLUMN email TEXT'); } catch (e) { /* exists */ }

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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_events (
        id SERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        title TEXT NOT NULL,
        start_date TEXT NOT NULL,
        start_time TEXT,
        end_date TEXT,
        end_time TEXT,
        location_name TEXT,
        address TEXT,
        notes TEXT,
        hotel_info TEXT,
        carpool_info TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    try { await pool.query('ALTER TABLE team_events ADD COLUMN batting_all INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* exists */ }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS practice_drills (
        id SERIAL PRIMARY KEY,
        team_event_id INTEGER NOT NULL REFERENCES team_events(id) ON DELETE CASCADE,
        drill_name TEXT NOT NULL,
        description TEXT,
        duration_minutes INTEGER NOT NULL DEFAULT 10,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_sub_events (
        id SERIAL PRIMARY KEY,
        team_event_id INTEGER NOT NULL REFERENCES team_events(id) ON DELETE CASCADE,
        sub_type TEXT NOT NULL DEFAULT 'game',
        title TEXT NOT NULL,
        start_date TEXT,
        start_time TEXT,
        end_time TEXT,
        location_name TEXT,
        opponent TEXT,
        notes TEXT,
        batting_all INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_lineups (
        id SERIAL PRIMARY KEY,
        team_event_id INTEGER REFERENCES team_events(id) ON DELETE CASCADE,
        sub_event_id INTEGER REFERENCES tournament_sub_events(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        position TEXT,
        batting_order INTEGER,
        is_starter INTEGER NOT NULL DEFAULT 1
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS rsvps (
        id SERIAL PRIMARY KEY,
        team_event_id INTEGER NOT NULL REFERENCES team_events(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        responded_at TIMESTAMPTZ,
        UNIQUE(team_event_id, player_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS reminder_log (
        id SERIAL PRIMARY KEY,
        team_event_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        reminder_type TEXT NOT NULL,
        channel TEXT NOT NULL,
        contact_value TEXT NOT NULL,
        sent_at TIMESTAMPTZ DEFAULT NOW()
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
      getStaff: async (id) => (await pool.query('SELECT * FROM staff WHERE id = $1', [id])).rows[0] || null,
      getStaffByPhone: async (phone) => (await pool.query('SELECT * FROM staff WHERE phone = $1', [phone])).rows[0] || null,
      addStaff: async (s) => pool.query('INSERT INTO staff (name, role, phone, email) VALUES ($1,$2,$3,$4)', [s.name, s.role, s.phone, s.email || null]),
      updateStaff: async (id, s) => pool.query('UPDATE staff SET name=$1, role=$2, phone=$3, email=$4 WHERE id=$5', [s.name, s.role, s.phone, s.email || null, id]),
      removeStaff: async (id) => pool.query('DELETE FROM staff WHERE id = $1', [id]),
      getPlayerEvents: async (playerId) => (await pool.query('SELECT * FROM events WHERE player_id = $1 ORDER BY start_date', [playerId])).rows,
      getAllEvents: async () => (await pool.query('SELECT * FROM events ORDER BY start_date')).rows,
      addEvent: async (e) => pool.query('INSERT INTO events (player_id, event_type, start_date, end_date, notes) VALUES ($1,$2,$3,$4,$5)', [e.player_id, e.event_type, e.start_date, e.end_date, e.notes]),
      removeEvent: async (id) => pool.query('DELETE FROM events WHERE id = $1', [id]),
      getAllTeamEvents: async () => (await pool.query('SELECT * FROM team_events ORDER BY start_date, start_time')).rows,
      getTeamEvent: async (id) => (await pool.query('SELECT * FROM team_events WHERE id = $1', [id])).rows[0] || null,
      addTeamEvent: async (e) => pool.query(
        'INSERT INTO team_events (event_type, title, start_date, start_time, end_date, end_time, location_name, address, notes, hotel_info, carpool_info) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [e.event_type, e.title, e.start_date, e.start_time, e.end_date, e.end_time, e.location_name, e.address, e.notes, e.hotel_info, e.carpool_info]
      ),
      updateTeamEvent: async (id, e) => pool.query(
        'UPDATE team_events SET event_type=$1, title=$2, start_date=$3, start_time=$4, end_date=$5, end_time=$6, location_name=$7, address=$8, notes=$9, hotel_info=$10, carpool_info=$11 WHERE id=$12',
        [e.event_type, e.title, e.start_date, e.start_time, e.end_date, e.end_time, e.location_name, e.address, e.notes, e.hotel_info, e.carpool_info, id]
      ),
      removeTeamEvent: async (id) => pool.query('DELETE FROM team_events WHERE id = $1', [id]),
      updateBattingAll: async (id, val) => pool.query('UPDATE team_events SET batting_all = $1 WHERE id = $2', [val ? 1 : 0, id]),
      getDrills: async (eventId) => (await pool.query('SELECT * FROM practice_drills WHERE team_event_id = $1 ORDER BY sort_order', [eventId])).rows,
      addDrill: async (d) => (await pool.query('INSERT INTO practice_drills (team_event_id, drill_name, description, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id', [d.team_event_id, d.drill_name, d.description, d.duration_minutes, d.sort_order])).rows[0],
      updateDrill: async (id, d) => pool.query('UPDATE practice_drills SET drill_name=$1, description=$2, duration_minutes=$3, sort_order=$4 WHERE id=$5', [d.drill_name, d.description, d.duration_minutes, d.sort_order, id]),
      removeDrill: async (id) => pool.query('DELETE FROM practice_drills WHERE id = $1', [id]),
      getSubEvents: async (eventId) => (await pool.query('SELECT * FROM tournament_sub_events WHERE team_event_id = $1 ORDER BY start_date, start_time, sort_order', [eventId])).rows,
      getSubEvent: async (id) => (await pool.query('SELECT * FROM tournament_sub_events WHERE id = $1', [id])).rows[0] || null,
      addSubEvent: async (s) => (await pool.query('INSERT INTO tournament_sub_events (team_event_id, sub_type, title, start_date, start_time, end_time, location_name, opponent, notes, batting_all, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id', [s.team_event_id, s.sub_type, s.title, s.start_date, s.start_time, s.end_time, s.location_name, s.opponent, s.notes, s.batting_all || 0, s.sort_order || 0])).rows[0],
      updateSubEvent: async (id, s) => pool.query('UPDATE tournament_sub_events SET sub_type=$1, title=$2, start_date=$3, start_time=$4, end_time=$5, location_name=$6, opponent=$7, notes=$8, batting_all=$9 WHERE id=$10', [s.sub_type, s.title, s.start_date, s.start_time, s.end_time, s.location_name, s.opponent, s.notes, s.batting_all || 0, id]),
      removeSubEvent: async (id) => pool.query('DELETE FROM tournament_sub_events WHERE id = $1', [id]),
      getLineupForEvent: async (eventId) => (await pool.query('SELECT l.*, p.player_name FROM game_lineups l JOIN players p ON l.player_id = p.id WHERE l.team_event_id = $1 ORDER BY l.batting_order NULLS LAST, p.player_name', [eventId])).rows,
      getLineupForSubEvent: async (subEventId) => (await pool.query('SELECT l.*, p.player_name FROM game_lineups l JOIN players p ON l.player_id = p.id WHERE l.sub_event_id = $1 ORDER BY l.batting_order NULLS LAST, p.player_name', [subEventId])).rows,
      saveLineup: async (entries) => {
        for (const e of entries) {
          if (e.team_event_id) {
            await pool.query('DELETE FROM game_lineups WHERE team_event_id = $1', [e.team_event_id]);
          } else {
            await pool.query('DELETE FROM game_lineups WHERE sub_event_id = $1', [e.sub_event_id]);
          }
          break;
        }
        for (const e of entries) {
          await pool.query('INSERT INTO game_lineups (team_event_id, sub_event_id, player_id, position, batting_order, is_starter) VALUES ($1,$2,$3,$4,$5,$6)', [e.team_event_id || null, e.sub_event_id || null, e.player_id, e.position, e.batting_order, e.is_starter]);
        }
      },
      getAdminByUsername: async (username) => (await pool.query('SELECT * FROM admins WHERE username = $1', [username])).rows[0] || null,
      getAdminById: async (id) => (await pool.query('SELECT * FROM admins WHERE id = $1', [id])).rows[0] || null,
      getAllAdmins: async () => (await pool.query('SELECT id, username, created_at FROM admins ORDER BY created_at')).rows,
      countAdmins: async () => parseInt((await pool.query('SELECT COUNT(*) as c FROM admins')).rows[0].c),
      createAdmin: async (username, passwordHash) => pool.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', [username, passwordHash]),
      updateAdminPassword: async (id, passwordHash) => pool.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [passwordHash, id]),
      removeAdmin: async (id) => pool.query('DELETE FROM admins WHERE id = $1', [id]),
      getRsvp: async (eventId, playerId) => (await pool.query('SELECT * FROM rsvps WHERE team_event_id = $1 AND player_id = $2', [eventId, playerId])).rows[0] || null,
      getRsvpsForEvent: async (eventId) => (await pool.query('SELECT r.*, p.player_name, p.parent_name FROM rsvps r JOIN players p ON r.player_id = p.id WHERE r.team_event_id = $1 ORDER BY p.player_name', [eventId])).rows,
      upsertRsvp: async (eventId, playerId, status) => pool.query(
        'INSERT INTO rsvps (team_event_id, player_id, status, responded_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (team_event_id, player_id) DO UPDATE SET status = $3, responded_at = NOW()',
        [eventId, playerId, status]
      ),
      hasReminderBeenSent: async (eventId, playerId, type) => {
        const { rows } = await pool.query('SELECT COUNT(*) as c FROM reminder_log WHERE team_event_id = $1 AND player_id = $2 AND reminder_type = $3', [eventId, playerId, type]);
        return parseInt(rows[0].c) > 0;
      },
      logReminder: async (eventId, playerId, type, channel, value) => pool.query(
        'INSERT INTO reminder_log (team_event_id, player_id, reminder_type, channel, contact_value) VALUES ($1,$2,$3,$4,$5)',
        [eventId, playerId, type, channel, value]
      ),
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

    try { sqliteDb.exec('ALTER TABLE staff ADD COLUMN email TEXT'); } catch (e) { /* exists */ }

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

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS team_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        title TEXT NOT NULL,
        start_date TEXT NOT NULL,
        start_time TEXT,
        end_date TEXT,
        end_time TEXT,
        location_name TEXT,
        address TEXT,
        notes TEXT,
        hotel_info TEXT,
        carpool_info TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    try { sqliteDb.exec('ALTER TABLE team_events ADD COLUMN batting_all INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* exists */ }

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS practice_drills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_event_id INTEGER NOT NULL REFERENCES team_events(id) ON DELETE CASCADE,
        drill_name TEXT NOT NULL,
        description TEXT,
        duration_minutes INTEGER NOT NULL DEFAULT 10,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS tournament_sub_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_event_id INTEGER NOT NULL REFERENCES team_events(id) ON DELETE CASCADE,
        sub_type TEXT NOT NULL DEFAULT 'game',
        title TEXT NOT NULL,
        start_date TEXT,
        start_time TEXT,
        end_time TEXT,
        location_name TEXT,
        opponent TEXT,
        notes TEXT,
        batting_all INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS game_lineups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_event_id INTEGER REFERENCES team_events(id) ON DELETE CASCADE,
        sub_event_id INTEGER REFERENCES tournament_sub_events(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        position TEXT,
        batting_order INTEGER,
        is_starter INTEGER NOT NULL DEFAULT 1
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS rsvps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_event_id INTEGER NOT NULL REFERENCES team_events(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        responded_at TEXT,
        UNIQUE(team_event_id, player_id)
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS reminder_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_event_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        reminder_type TEXT NOT NULL,
        channel TEXT NOT NULL,
        contact_value TEXT NOT NULL,
        sent_at TEXT DEFAULT (datetime('now'))
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
      getStaff: async (id) => sqliteDb.prepare('SELECT * FROM staff WHERE id = ?').get(id) || null,
      getStaffByPhone: async (phone) => sqliteDb.prepare('SELECT * FROM staff WHERE phone = ?').get(phone) || null,
      addStaff: async (s) => sqliteDb.prepare('INSERT INTO staff (name, role, phone, email) VALUES (?,?,?,?)').run(s.name, s.role, s.phone, s.email || null),
      updateStaff: async (id, s) => sqliteDb.prepare('UPDATE staff SET name=?, role=?, phone=?, email=? WHERE id=?').run(s.name, s.role, s.phone, s.email || null, id),
      removeStaff: async (id) => sqliteDb.prepare('DELETE FROM staff WHERE id = ?').run(id),
      getPlayerEvents: async (playerId) => sqliteDb.prepare('SELECT * FROM events WHERE player_id = ? ORDER BY start_date').all(playerId),
      getAllEvents: async () => sqliteDb.prepare('SELECT * FROM events ORDER BY start_date').all(),
      addEvent: async (e) => sqliteDb.prepare('INSERT INTO events (player_id, event_type, start_date, end_date, notes) VALUES (?,?,?,?,?)').run(e.player_id, e.event_type, e.start_date, e.end_date, e.notes),
      removeEvent: async (id) => sqliteDb.prepare('DELETE FROM events WHERE id = ?').run(id),
      getAllTeamEvents: async () => sqliteDb.prepare('SELECT * FROM team_events ORDER BY start_date, start_time').all(),
      getTeamEvent: async (id) => sqliteDb.prepare('SELECT * FROM team_events WHERE id = ?').get(id) || null,
      addTeamEvent: async (e) => sqliteDb.prepare(
        'INSERT INTO team_events (event_type, title, start_date, start_time, end_date, end_time, location_name, address, notes, hotel_info, carpool_info) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      ).run(e.event_type, e.title, e.start_date, e.start_time, e.end_date, e.end_time, e.location_name, e.address, e.notes, e.hotel_info, e.carpool_info),
      updateTeamEvent: async (id, e) => sqliteDb.prepare(
        'UPDATE team_events SET event_type=?, title=?, start_date=?, start_time=?, end_date=?, end_time=?, location_name=?, address=?, notes=?, hotel_info=?, carpool_info=? WHERE id=?'
      ).run(e.event_type, e.title, e.start_date, e.start_time, e.end_date, e.end_time, e.location_name, e.address, e.notes, e.hotel_info, e.carpool_info, id),
      removeTeamEvent: async (id) => sqliteDb.prepare('DELETE FROM team_events WHERE id = ?').run(id),
      updateBattingAll: async (id, val) => sqliteDb.prepare('UPDATE team_events SET batting_all = ? WHERE id = ?').run(val ? 1 : 0, id),
      getDrills: async (eventId) => sqliteDb.prepare('SELECT * FROM practice_drills WHERE team_event_id = ? ORDER BY sort_order').all(eventId),
      addDrill: async (d) => {
        const r = sqliteDb.prepare('INSERT INTO practice_drills (team_event_id, drill_name, description, duration_minutes, sort_order) VALUES (?,?,?,?,?)').run(d.team_event_id, d.drill_name, d.description, d.duration_minutes, d.sort_order);
        return { id: r.lastInsertRowid };
      },
      updateDrill: async (id, d) => sqliteDb.prepare('UPDATE practice_drills SET drill_name=?, description=?, duration_minutes=?, sort_order=? WHERE id=?').run(d.drill_name, d.description, d.duration_minutes, d.sort_order, id),
      removeDrill: async (id) => sqliteDb.prepare('DELETE FROM practice_drills WHERE id = ?').run(id),
      getSubEvents: async (eventId) => sqliteDb.prepare('SELECT * FROM tournament_sub_events WHERE team_event_id = ? ORDER BY start_date, start_time, sort_order').all(eventId),
      getSubEvent: async (id) => sqliteDb.prepare('SELECT * FROM tournament_sub_events WHERE id = ?').get(id) || null,
      addSubEvent: async (s) => {
        const r = sqliteDb.prepare('INSERT INTO tournament_sub_events (team_event_id, sub_type, title, start_date, start_time, end_time, location_name, opponent, notes, batting_all, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(s.team_event_id, s.sub_type, s.title, s.start_date, s.start_time, s.end_time, s.location_name, s.opponent, s.notes, s.batting_all || 0, s.sort_order || 0);
        return { id: r.lastInsertRowid };
      },
      updateSubEvent: async (id, s) => sqliteDb.prepare('UPDATE tournament_sub_events SET sub_type=?, title=?, start_date=?, start_time=?, end_time=?, location_name=?, opponent=?, notes=?, batting_all=? WHERE id=?').run(s.sub_type, s.title, s.start_date, s.start_time, s.end_time, s.location_name, s.opponent, s.notes, s.batting_all || 0, id),
      removeSubEvent: async (id) => sqliteDb.prepare('DELETE FROM tournament_sub_events WHERE id = ?').run(id),
      getLineupForEvent: async (eventId) => sqliteDb.prepare('SELECT l.*, p.player_name FROM game_lineups l JOIN players p ON l.player_id = p.id WHERE l.team_event_id = ? ORDER BY l.batting_order, p.player_name').all(eventId),
      getLineupForSubEvent: async (subEventId) => sqliteDb.prepare('SELECT l.*, p.player_name FROM game_lineups l JOIN players p ON l.player_id = p.id WHERE l.sub_event_id = ? ORDER BY l.batting_order, p.player_name').all(subEventId),
      saveLineup: async (entries) => {
        if (entries.length === 0) return;
        if (entries[0].team_event_id) {
          sqliteDb.prepare('DELETE FROM game_lineups WHERE team_event_id = ?').run(entries[0].team_event_id);
        } else {
          sqliteDb.prepare('DELETE FROM game_lineups WHERE sub_event_id = ?').run(entries[0].sub_event_id);
        }
        const ins = sqliteDb.prepare('INSERT INTO game_lineups (team_event_id, sub_event_id, player_id, position, batting_order, is_starter) VALUES (?,?,?,?,?,?)');
        for (const e of entries) {
          ins.run(e.team_event_id || null, e.sub_event_id || null, e.player_id, e.position, e.batting_order, e.is_starter);
        }
      },
      getAdminByUsername: async (username) => sqliteDb.prepare('SELECT * FROM admins WHERE username = ?').get(username) || null,
      getAdminById: async (id) => sqliteDb.prepare('SELECT * FROM admins WHERE id = ?').get(id) || null,
      getAllAdmins: async () => sqliteDb.prepare('SELECT id, username, created_at FROM admins ORDER BY created_at').all(),
      countAdmins: async () => sqliteDb.prepare('SELECT COUNT(*) as c FROM admins').get().c,
      createAdmin: async (username, passwordHash) => sqliteDb.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, passwordHash),
      updateAdminPassword: async (id, passwordHash) => sqliteDb.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(passwordHash, id),
      removeAdmin: async (id) => sqliteDb.prepare('DELETE FROM admins WHERE id = ?').run(id),
      getRsvp: async (eventId, playerId) => sqliteDb.prepare('SELECT * FROM rsvps WHERE team_event_id = ? AND player_id = ?').get(eventId, playerId) || null,
      getRsvpsForEvent: async (eventId) => sqliteDb.prepare('SELECT r.*, p.player_name, p.parent_name FROM rsvps r JOIN players p ON r.player_id = p.id WHERE r.team_event_id = ? ORDER BY p.player_name').all(eventId),
      upsertRsvp: async (eventId, playerId, status) => {
        const existing = sqliteDb.prepare('SELECT id FROM rsvps WHERE team_event_id = ? AND player_id = ?').get(eventId, playerId);
        if (existing) {
          sqliteDb.prepare('UPDATE rsvps SET status = ?, responded_at = ? WHERE id = ?').run(status, new Date().toISOString(), existing.id);
        } else {
          sqliteDb.prepare('INSERT INTO rsvps (team_event_id, player_id, status, responded_at) VALUES (?, ?, ?, ?)').run(eventId, playerId, status, new Date().toISOString());
        }
      },
      hasReminderBeenSent: async (eventId, playerId, type) => {
        const row = sqliteDb.prepare('SELECT COUNT(*) as c FROM reminder_log WHERE team_event_id = ? AND player_id = ? AND reminder_type = ?').get(eventId, playerId, type);
        return row.c > 0;
      },
      logReminder: async (eventId, playerId, type, channel, value) => {
        sqliteDb.prepare('INSERT INTO reminder_log (team_event_id, player_id, reminder_type, channel, contact_value) VALUES (?,?,?,?,?)').run(eventId, playerId, type, channel, value);
      },
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
  getStaff: (...args) => impl.getStaff(...args),
  getStaffByPhone: (...args) => impl.getStaffByPhone(...args),
  addStaff: (...args) => impl.addStaff(...args),
  updateStaff: (...args) => impl.updateStaff(...args),
  removeStaff: (...args) => impl.removeStaff(...args),
  getPlayerEvents: (...args) => impl.getPlayerEvents(...args),
  getAllEvents: (...args) => impl.getAllEvents(...args),
  addEvent: (...args) => impl.addEvent(...args),
  removeEvent: (...args) => impl.removeEvent(...args),
  getAllTeamEvents: (...args) => impl.getAllTeamEvents(...args),
  getTeamEvent: (...args) => impl.getTeamEvent(...args),
  addTeamEvent: (...args) => impl.addTeamEvent(...args),
  updateTeamEvent: (...args) => impl.updateTeamEvent(...args),
  removeTeamEvent: (...args) => impl.removeTeamEvent(...args),
  updateBattingAll: (...args) => impl.updateBattingAll(...args),
  getDrills: (...args) => impl.getDrills(...args),
  addDrill: (...args) => impl.addDrill(...args),
  updateDrill: (...args) => impl.updateDrill(...args),
  removeDrill: (...args) => impl.removeDrill(...args),
  getSubEvents: (...args) => impl.getSubEvents(...args),
  getSubEvent: (...args) => impl.getSubEvent(...args),
  addSubEvent: (...args) => impl.addSubEvent(...args),
  updateSubEvent: (...args) => impl.updateSubEvent(...args),
  removeSubEvent: (...args) => impl.removeSubEvent(...args),
  getLineupForEvent: (...args) => impl.getLineupForEvent(...args),
  getLineupForSubEvent: (...args) => impl.getLineupForSubEvent(...args),
  saveLineup: (...args) => impl.saveLineup(...args),
  getAdminByUsername: (...args) => impl.getAdminByUsername(...args),
  getAdminById: (...args) => impl.getAdminById(...args),
  getAllAdmins: (...args) => impl.getAllAdmins(...args),
  countAdmins: (...args) => impl.countAdmins(...args),
  createAdmin: (...args) => impl.createAdmin(...args),
  updateAdminPassword: (...args) => impl.updateAdminPassword(...args),
  removeAdmin: (...args) => impl.removeAdmin(...args),
  getRsvp: (...args) => impl.getRsvp(...args),
  getRsvpsForEvent: (...args) => impl.getRsvpsForEvent(...args),
  upsertRsvp: (...args) => impl.upsertRsvp(...args),
  hasReminderBeenSent: (...args) => impl.hasReminderBeenSent(...args),
  logReminder: (...args) => impl.logReminder(...args),
};
