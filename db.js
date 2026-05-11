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
  'jersey_number TEXT',
  'coach_assigned_positions TEXT',
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
    try { await pool.query('ALTER TABLE admins ADD COLUMN email TEXT'); } catch (e) { /* exists */ }

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

    // Salvage start_time/end_time rows that were stored as Postgres array
    // literals (e.g. {"","18:00"}) when the multi-day form posted duplicate
    // fields. substring() returns the first HH:MM match or NULL.
    try {
      await pool.query("UPDATE team_events SET start_time = substring(start_time from '\\d{1,2}:\\d{2}') WHERE start_time LIKE '{%}'");
      await pool.query("UPDATE team_events SET end_time = substring(end_time from '\\d{1,2}:\\d{2}') WHERE end_time LIKE '{%}'");
    } catch (e) { /* best-effort cleanup */ }

    // Track one-time data migrations so they don't re-run after admin edits.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // One-time normalization: every weekday practice runs 6:00pm–8:00pm.
    // Weekend practices are not touched. Per user instruction.
    try {
      const m = await pool.query("SELECT 1 FROM migrations WHERE name = 'normalize_weekday_practice_times_v1'");
      if (m.rowCount === 0) {
        await pool.query(`
          UPDATE team_events
          SET start_time = '18:00', end_time = '20:00'
          WHERE event_type = 'practice'
            AND EXTRACT(DOW FROM start_date::date) BETWEEN 1 AND 5
        `);
        await pool.query("INSERT INTO migrations (name) VALUES ('normalize_weekday_practice_times_v1')");
      }
    } catch (e) { /* best-effort */ }

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

    try { await pool.query('ALTER TABLE practice_drills ADD COLUMN coach_notes TEXT'); } catch (e) { /* exists */ }
    try { await pool.query('ALTER TABLE practice_drills ADD COLUMN assigned_staff TEXT'); } catch (e) { /* exists */ }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT
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
      CREATE TABLE IF NOT EXISTS lineup_grid (
        id SERIAL PRIMARY KEY,
        team_event_id INTEGER REFERENCES team_events(id) ON DELETE CASCADE,
        sub_event_id INTEGER REFERENCES tournament_sub_events(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        batting_order INTEGER NOT NULL,
        inning INTEGER NOT NULL,
        position_number INTEGER,
        status TEXT NOT NULL DEFAULT 'field'
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS parent_accounts (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    try { await pool.query('ALTER TABLE parent_accounts ADD COLUMN last_login_at TIMESTAMPTZ'); } catch (e) { /* exists */ }
    try { await pool.query("ALTER TABLE parent_accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'parent'"); } catch (e) { /* exists */ }
    try { await pool.query('ALTER TABLE parent_accounts ADD COLUMN approved BOOLEAN NOT NULL DEFAULT true'); } catch (e) { /* exists */ }
    try { await pool.query('ALTER TABLE parent_accounts ADD COLUMN username TEXT UNIQUE'); } catch (e) { /* exists */ }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS player_parents (
        id SERIAL PRIMARY KEY,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES parent_accounts(id) ON DELETE CASCADE,
        UNIQUE(player_id, account_id)
      )
    `);

    // Migrate existing parent_phone links into player_parents join table
    const { rows: migrationCheck } = await pool.query('SELECT COUNT(*) as c FROM player_parents');
    if (parseInt(migrationCheck[0].c) === 0) {
      const { rows: accounts } = await pool.query('SELECT id, phone FROM parent_accounts');
      for (const acct of accounts) {
        const { rows: linked } = await pool.query('SELECT id FROM players WHERE parent_phone = $1', [acct.phone]);
        for (const p of linked) {
          await pool.query('INSERT INTO player_parents (player_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [p.id, acct.id]);
        }
      }
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_messages (
        id SERIAL PRIMARY KEY,
        author_name TEXT NOT NULL,
        author_type TEXT NOT NULL DEFAULT 'parent',
        message TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS saved_locations (
        id SERIAL PRIMARY KEY,
        location_name TEXT NOT NULL,
        address TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    try { await pool.query('ALTER TABLE team_events ADD COLUMN opponent_name TEXT'); } catch (e) { /* exists */ }
    try { await pool.query('ALTER TABLE team_events ADD COLUMN our_score INTEGER'); } catch (e) { /* exists */ }
    try { await pool.query('ALTER TABLE team_events ADD COLUMN opponent_score INTEGER'); } catch (e) { /* exists */ }
    try { await pool.query('ALTER TABLE team_messages ADD COLUMN parent_id INTEGER REFERENCES team_messages(id) ON DELETE CASCADE'); } catch (e) { /* exists */ }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS board_reactions (
        id SERIAL PRIMARY KEY,
        message_id INTEGER NOT NULL REFERENCES team_messages(id) ON DELETE CASCADE,
        author_name TEXT NOT NULL,
        reaction_type TEXT NOT NULL CHECK (reaction_type IN ('up', 'down')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(message_id, author_name, reaction_type)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS score_keepers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        access_token TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS live_games (
        id SERIAL PRIMARY KEY,
        team_event_id INTEGER REFERENCES team_events(id) ON DELETE SET NULL,
        sub_event_id INTEGER REFERENCES tournament_sub_events(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'setup',
        home_away TEXT NOT NULL DEFAULT 'home',
        current_inning INTEGER NOT NULL DEFAULT 1,
        current_half TEXT NOT NULL DEFAULT 'top',
        outs INTEGER NOT NULL DEFAULT 0,
        our_score INTEGER NOT NULL DEFAULT 0,
        opp_score INTEGER NOT NULL DEFAULT 0,
        balls INTEGER NOT NULL DEFAULT 0,
        strikes INTEGER NOT NULL DEFAULT 0,
        runner_first TEXT,
        runner_second TEXT,
        runner_third TEXT,
        current_batter_us INTEGER NOT NULL DEFAULT 0,
        current_batter_opp INTEGER NOT NULL DEFAULT 0,
        current_pitcher_us INTEGER,
        opp_pitcher_name TEXT,
        opp_team_name TEXT NOT NULL DEFAULT 'Opponent',
        current_at_bat_id INTEGER,
        total_innings INTEGER NOT NULL DEFAULT 6,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        active_scorer_name TEXT,
        active_scorer_at TIMESTAMPTZ
      )
    `);

    await pool.query('ALTER TABLE live_games ADD COLUMN IF NOT EXISTS active_scorer_name TEXT').catch(() => {});
    await pool.query('ALTER TABLE live_games ADD COLUMN IF NOT EXISTS active_scorer_at TIMESTAMPTZ').catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_roster (
        id SERIAL PRIMARY KEY,
        game_id INTEGER NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        batting_order INTEGER NOT NULL,
        current_position INTEGER,
        is_active INTEGER NOT NULL DEFAULT 1,
        entered_inning INTEGER NOT NULL DEFAULT 1,
        exited_inning INTEGER
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS opponent_roster (
        id SERIAL PRIMARY KEY,
        game_id INTEGER NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
        player_name TEXT NOT NULL,
        jersey_number TEXT,
        batting_order INTEGER NOT NULL,
        current_position INTEGER,
        is_active INTEGER NOT NULL DEFAULT 1
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS at_bats (
        id SERIAL PRIMARY KEY,
        game_id INTEGER NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
        inning INTEGER NOT NULL,
        half TEXT NOT NULL,
        is_our_team INTEGER NOT NULL,
        batter_player_id INTEGER,
        batter_name TEXT NOT NULL,
        pitcher_player_id INTEGER,
        pitcher_name TEXT,
        batting_order_pos INTEGER NOT NULL,
        result TEXT,
        hit_type TEXT,
        is_hard_contact INTEGER,
        rbi_count INTEGER NOT NULL DEFAULT 0,
        outs_on_play INTEGER NOT NULL DEFAULT 0,
        fielders_involved TEXT,
        error_position INTEGER,
        error_player_id INTEGER,
        total_pitches INTEGER NOT NULL DEFAULT 0,
        balls_in_count INTEGER NOT NULL DEFAULT 0,
        strikes_in_count INTEGER NOT NULL DEFAULT 0,
        runners_on_base TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pitches (
        id SERIAL PRIMARY KEY,
        game_id INTEGER NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
        at_bat_id INTEGER NOT NULL REFERENCES at_bats(id) ON DELETE CASCADE,
        inning INTEGER NOT NULL,
        half TEXT NOT NULL,
        pitcher_player_id INTEGER,
        pitcher_name TEXT,
        batter_player_id INTEGER,
        batter_name TEXT,
        pitch_number_in_ab INTEGER NOT NULL,
        pitch_number_game INTEGER NOT NULL DEFAULT 0,
        result TEXT NOT NULL,
        balls_before INTEGER NOT NULL DEFAULT 0,
        strikes_before INTEGER NOT NULL DEFAULT 0,
        runners_on TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_chat (
        id SERIAL PRIMARY KEY,
        game_id INTEGER NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
        author_name TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_undo_log (
        id SERIAL PRIMARY KEY,
        game_id INTEGER NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
        action_type TEXT NOT NULL,
        action_data TEXT,
        prev_game_state TEXT,
        sequence_num INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS programs (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        author TEXT,
        program_type TEXT NOT NULL DEFAULT 'at_home',
        schedule_type TEXT NOT NULL DEFAULT 'weekly',
        published INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS program_days (
        id SERIAL PRIMARY KEY,
        program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
        day_label TEXT NOT NULL,
        day_number INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS program_activities (
        id SERIAL PRIMARY KEY,
        program_day_id INTEGER NOT NULL REFERENCES program_days(id) ON DELETE CASCADE,
        activity_name TEXT NOT NULL,
        description TEXT,
        instructions TEXT,
        reps TEXT,
        link_url TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    await pool.query('ALTER TABLE program_activities ADD COLUMN IF NOT EXISTS link_url TEXT').catch(() => {});
    await pool.query('ALTER TABLE program_activities ADD COLUMN IF NOT EXISTS image_url TEXT').catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS program_assignments (
        id SERIAL PRIMARY KEY,
        program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        assigned_by_staff_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        send_reminders INTEGER NOT NULL DEFAULT 1,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(program_id, player_id)
      )
    `);

    try { await pool.query('ALTER TABLE programs ADD COLUMN assigned_positions TEXT'); } catch (e) { /* exists */ }
    try { await pool.query('ALTER TABLE program_assignments ADD COLUMN start_date DATE'); } catch (e) { /* exists */ }
    try { await pool.query('ALTER TABLE program_assignments ADD COLUMN end_date DATE'); } catch (e) { /* exists */ }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS program_completions (
        id SERIAL PRIMARY KEY,
        program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        program_day_id INTEGER NOT NULL REFERENCES program_days(id) ON DELETE CASCADE,
        completed_at TIMESTAMPTZ DEFAULT NOW(),
        week_of DATE,
        UNIQUE(program_id, player_id, program_day_id, week_of)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS program_equipment (
        id SERIAL PRIMARY KEY,
        program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
        item_name TEXT NOT NULL,
        is_required INTEGER NOT NULL DEFAULT 1,
        buy_url TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS program_reminder_log (
        id SERIAL PRIMARY KEY,
        program_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        sent_date DATE NOT NULL,
        sent_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(program_id, player_id, sent_date)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS quizzes (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        position TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS quiz_questions (
        id SERIAL PRIMARY KEY,
        quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        question_text TEXT NOT NULL,
        option_a TEXT NOT NULL,
        option_b TEXT NOT NULL,
        option_c TEXT,
        option_d TEXT,
        correct_answer TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS quiz_assignments (
        id SERIAL PRIMARY KEY,
        quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        assigned_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(quiz_id, player_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS quiz_attempts (
        id SERIAL PRIMARY KEY,
        quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        score INTEGER NOT NULL,
        total INTEGER NOT NULL,
        answers_json TEXT,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ DEFAULT NOW()
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
            baseball_iq=$12, contacts=$13, jersey_number=$14, coach_assigned_positions=$15,
            profile_updated_at=NOW()
          WHERE id=$16`,
          [data.birthdate, data.best_positions, data.favorite_positions,
           data.arm_strength, data.throwing_accuracy, data.contact_hitting, data.power_hitting,
           data.pitching, data.infield_defense, data.outfield_defense, data.catcher_skill,
           data.baseball_iq, data.contacts, data.jersey_number, data.coach_assigned_positions, id]
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
        'INSERT INTO team_events (event_type, title, start_date, start_time, end_date, end_time, location_name, address, notes, hotel_info, carpool_info, opponent_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [e.event_type, e.title, e.start_date, e.start_time, e.end_date, e.end_time, e.location_name, e.address, e.notes, e.hotel_info, e.carpool_info, e.opponent_name || null]
      ),
      updateTeamEvent: async (id, e) => pool.query(
        'UPDATE team_events SET event_type=$1, title=$2, start_date=$3, start_time=$4, end_date=$5, end_time=$6, location_name=$7, address=$8, notes=$9, hotel_info=$10, carpool_info=$11, opponent_name=$12 WHERE id=$13',
        [e.event_type, e.title, e.start_date, e.start_time, e.end_date, e.end_time, e.location_name, e.address, e.notes, e.hotel_info, e.carpool_info, e.opponent_name || null, id]
      ),
      removeTeamEvent: async (id) => pool.query('DELETE FROM team_events WHERE id = $1', [id]),
      updateBattingAll: async (id, val) => pool.query('UPDATE team_events SET batting_all = $1 WHERE id = $2', [val ? 1 : 0, id]),
      getDrills: async (eventId) => (await pool.query('SELECT * FROM practice_drills WHERE team_event_id = $1 ORDER BY sort_order', [eventId])).rows,
      addDrill: async (d) => (await pool.query('INSERT INTO practice_drills (team_event_id, drill_name, description, duration_minutes, sort_order, coach_notes, assigned_staff) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [d.team_event_id, d.drill_name, d.description, d.duration_minutes, d.sort_order, d.coach_notes || null, d.assigned_staff || null])).rows[0],
      updateDrill: async (id, d) => pool.query('UPDATE practice_drills SET drill_name=$1, description=$2, duration_minutes=$3, sort_order=$4, coach_notes=$5, assigned_staff=$6 WHERE id=$7', [d.drill_name, d.description, d.duration_minutes, d.sort_order, d.coach_notes || null, d.assigned_staff || null, id]),
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
      getLineupGrid: async (eventId, subEventId) => {
        if (eventId) return (await pool.query('SELECT g.*, p.player_name, p.best_positions, p.jersey_number FROM lineup_grid g JOIN players p ON g.player_id = p.id WHERE g.team_event_id = $1 ORDER BY g.batting_order, g.inning', [eventId])).rows;
        return (await pool.query('SELECT g.*, p.player_name, p.best_positions, p.jersey_number FROM lineup_grid g JOIN players p ON g.player_id = p.id WHERE g.sub_event_id = $1 ORDER BY g.batting_order, g.inning', [subEventId])).rows;
      },
      saveLineupGrid: async (eventId, subEventId, entries) => {
        if (eventId) await pool.query('DELETE FROM lineup_grid WHERE team_event_id = $1', [eventId]);
        else await pool.query('DELETE FROM lineup_grid WHERE sub_event_id = $1', [subEventId]);
        for (const e of entries) {
          await pool.query('INSERT INTO lineup_grid (team_event_id, sub_event_id, player_id, batting_order, inning, position_number, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [eventId || null, subEventId || null, e.player_id, e.batting_order, e.inning, e.position_number || null, e.status || 'field']);
        }
      },
      getAdminByUsername: async (username) => (await pool.query('SELECT * FROM admins WHERE username = $1', [username])).rows[0] || null,
      getAdminById: async (id) => (await pool.query('SELECT * FROM admins WHERE id = $1', [id])).rows[0] || null,
      getAllAdmins: async () => (await pool.query('SELECT id, username, created_at FROM admins ORDER BY created_at')).rows,
      countAdmins: async () => parseInt((await pool.query('SELECT COUNT(*) as c FROM admins')).rows[0].c),
      createAdmin: async (username, passwordHash) => pool.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', [username, passwordHash]),
      updateAdminPassword: async (id, passwordHash) => pool.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [passwordHash, id]),
      updateAdminEmail: async (id, email) => pool.query('UPDATE admins SET email = $1 WHERE id = $2', [email, id]),
      getAdminByEmail: async (email) => (await pool.query('SELECT * FROM admins WHERE LOWER(email) = LOWER($1)', [email])).rows[0] || null,
      removeAdmin: async (id) => pool.query('DELETE FROM admins WHERE id = $1', [id]),
      getRsvp: async (eventId, playerId) => (await pool.query('SELECT * FROM rsvps WHERE team_event_id = $1 AND player_id = $2', [eventId, playerId])).rows[0] || null,
      getRsvpsForEvent: async (eventId) => (await pool.query('SELECT r.*, p.player_name, p.parent_name FROM rsvps r JOIN players p ON r.player_id = p.id WHERE r.team_event_id = $1 ORDER BY p.player_name', [eventId])).rows,
      getRsvpCountsAll: async () => (await pool.query("SELECT team_event_id, status, COUNT(*)::int as cnt FROM rsvps GROUP BY team_event_id, status")).rows,
      clearGameScore: async (id) => pool.query('UPDATE team_events SET our_score = NULL, opponent_score = NULL WHERE id = $1', [id]),
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
      hasProgramReminderBeenSent: async (sentDate) => {
        const { rows } = await pool.query('SELECT COUNT(*) as c FROM program_reminder_log WHERE sent_date = $1', [sentDate]);
        return parseInt(rows[0].c) > 0;
      },
      logProgramReminder: async (programId, playerId, sentDate) => pool.query(
        'INSERT INTO program_reminder_log (program_id, player_id, sent_date) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [programId, playerId, sentDate]
      ),
      updateJerseyNumber: async (id, number) => pool.query('UPDATE players SET jersey_number = $1 WHERE id = $2', [number, id]),
      getParentAccountByPhone: async (phone) => (await pool.query('SELECT * FROM parent_accounts WHERE phone = $1', [phone])).rows[0] || null,
      getParentAccountByUsername: async (username) => (await pool.query('SELECT * FROM parent_accounts WHERE LOWER(username) = LOWER($1)', [username])).rows[0] || null,
      createParentAccount: async (phone, displayName, passwordHash) => pool.query('INSERT INTO parent_accounts (phone, display_name, password_hash) VALUES ($1, $2, $3)', [phone, displayName, passwordHash]),
      getAllParentAccounts: async () => (await pool.query('SELECT * FROM parent_accounts ORDER BY display_name')).rows,
      getParentAccountById: async (id) => (await pool.query('SELECT * FROM parent_accounts WHERE id = $1', [id])).rows[0] || null,
      updateParentAccountPassword: async (id, passwordHash) => pool.query('UPDATE parent_accounts SET password_hash = $1 WHERE id = $2', [passwordHash, id]),
      updateParentAccountName: async (id, displayName) => pool.query('UPDATE parent_accounts SET display_name = $1 WHERE id = $2', [displayName, id]),
      updateParentAccountPhone: async (id, phone) => pool.query('UPDATE parent_accounts SET phone = $1 WHERE id = $2', [phone, id]),
      updateParentAccountUsername: async (id, username) => pool.query('UPDATE parent_accounts SET username = $1 WHERE id = $2', [username || null, id]),
      updateParentLoginTime: async (phone) => pool.query('UPDATE parent_accounts SET last_login_at = NOW() WHERE phone = $1', [phone]),
      deleteParentAccount: async (id) => pool.query('DELETE FROM parent_accounts WHERE id = $1', [id]),
      updatePlayerParentPhone: async (playerId, phone) => pool.query('UPDATE players SET parent_phone = $1 WHERE id = $2', [phone, playerId]),
      linkPlayerToAccount: async (playerId, accountId) => pool.query('INSERT INTO player_parents (player_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [playerId, accountId]),
      unlinkPlayerFromAccount: async (playerId, accountId) => pool.query('DELETE FROM player_parents WHERE player_id = $1 AND account_id = $2', [playerId, accountId]),
      getLinkedPlayersByAccount: async (accountId) => (await pool.query('SELECT p.* FROM players p JOIN player_parents pp ON p.id = pp.player_id WHERE pp.account_id = $1 ORDER BY p.player_name', [accountId])).rows,
      getLinkedAccountsByPlayer: async (playerId) => (await pool.query('SELECT pa.* FROM parent_accounts pa JOIN player_parents pp ON pa.id = pp.account_id WHERE pp.player_id = $1 ORDER BY pa.display_name', [playerId])).rows,
      getAllPlayerParentLinks: async () => (await pool.query('SELECT pp.*, p.player_name, pa.display_name, pa.phone, pa.role FROM player_parents pp JOIN players p ON pp.player_id = p.id JOIN parent_accounts pa ON pp.account_id = pa.id ORDER BY p.player_name')).rows,
      updateAccountRole: async (id, role) => pool.query('UPDATE parent_accounts SET role = $1 WHERE id = $2', [role, id]),
      updateAccountApproved: async (id, approved) => pool.query('UPDATE parent_accounts SET approved = $1 WHERE id = $2', [approved, id]),
      getPendingFanAccounts: async () => (await pool.query("SELECT pa.*, array_agg(pp.player_id) as player_ids FROM parent_accounts pa LEFT JOIN player_parents pp ON pa.id = pp.account_id WHERE pa.role = 'fan' AND pa.approved = false GROUP BY pa.id ORDER BY pa.created_at DESC")).rows,
      createParentAccountFull: async (phone, displayName, passwordHash, role, approved) => {
        const r = await pool.query('INSERT INTO parent_accounts (phone, display_name, password_hash, role, approved) VALUES ($1, $2, $3, $4, $5) RETURNING id', [phone, displayName, passwordHash, role, approved]);
        return r.rows[0];
      },
      updateGameScore: async (id, ourScore, opponentScore) => pool.query('UPDATE team_events SET our_score = $1, opponent_score = $2 WHERE id = $3', [ourScore, opponentScore, id]),
      clearLineupGrid: async (eventId, subEventId) => {
        if (eventId) {
          await pool.query('DELETE FROM lineup_grid WHERE team_event_id = $1', [eventId]);
          await pool.query('DELETE FROM game_lineups WHERE team_event_id = $1', [eventId]);
        } else {
          await pool.query('DELETE FROM lineup_grid WHERE sub_event_id = $1', [subEventId]);
          await pool.query('DELETE FROM game_lineups WHERE sub_event_id = $1', [subEventId]);
        }
      },
      clearPlayerFromLineupGrid: async (eventId, subEventId, playerId) => {
        if (eventId) await pool.query('DELETE FROM lineup_grid WHERE team_event_id = $1 AND player_id = $2', [eventId, playerId]);
        else await pool.query('DELETE FROM lineup_grid WHERE sub_event_id = $1 AND player_id = $2', [subEventId, playerId]);
      },
      getAllMessages: async () => (await pool.query('SELECT m.*, (SELECT COUNT(*) FROM team_messages r WHERE r.parent_id = m.id) as reply_count FROM team_messages m WHERE m.parent_id IS NULL ORDER BY m.pinned DESC, m.created_at DESC')).rows,
      getTopicReplies: async (topicId) => (await pool.query('SELECT * FROM team_messages WHERE parent_id = $1 ORDER BY created_at ASC', [topicId])).rows,
      addMessage: async (m) => pool.query('INSERT INTO team_messages (author_name, author_type, message, parent_id) VALUES ($1,$2,$3,$4)', [m.author_name, m.author_type, m.message, m.parent_id || null]),
      removeMessage: async (id) => pool.query('DELETE FROM team_messages WHERE id = $1', [id]),
      togglePinMessage: async (id) => pool.query('UPDATE team_messages SET pinned = CASE WHEN pinned = 1 THEN 0 ELSE 1 END WHERE id = $1', [id]),
      toggleReaction: async (messageId, authorName, reactionType) => {
        const existing = await pool.query('SELECT id FROM board_reactions WHERE message_id = $1 AND author_name = $2 AND reaction_type = $3', [messageId, authorName, reactionType]);
        if (existing.rows.length > 0) {
          await pool.query('DELETE FROM board_reactions WHERE id = $1', [existing.rows[0].id]);
        } else {
          await pool.query('DELETE FROM board_reactions WHERE message_id = $1 AND author_name = $2', [messageId, authorName]);
          await pool.query('INSERT INTO board_reactions (message_id, author_name, reaction_type) VALUES ($1, $2, $3)', [messageId, authorName, reactionType]);
        }
      },
      getReactionsForMessages: async (messageIds) => {
        if (!messageIds.length) return {};
        const placeholders = messageIds.map((_, i) => `$${i + 1}`).join(',');
        const rows = (await pool.query(`SELECT message_id, reaction_type, COUNT(*) as cnt, array_agg(author_name) as authors FROM board_reactions WHERE message_id IN (${placeholders}) GROUP BY message_id, reaction_type`, messageIds)).rows;
        const result = {};
        for (const r of rows) {
          if (!result[r.message_id]) result[r.message_id] = { up: 0, down: 0, upAuthors: [], downAuthors: [] };
          result[r.message_id][r.reaction_type] = parseInt(r.cnt);
          result[r.message_id][r.reaction_type + 'Authors'] = r.authors || [];
        }
        return result;
      },
      getAllSavedLocations: async () => (await pool.query('SELECT * FROM saved_locations ORDER BY location_name')).rows,
      addSavedLocation: async (name, address) => pool.query('INSERT INTO saved_locations (location_name, address) VALUES ($1, $2)', [name, address]),
      removeSavedLocation: async (id) => pool.query('DELETE FROM saved_locations WHERE id = $1', [id]),

      getAllScoreKeepers: async () => (await pool.query('SELECT * FROM score_keepers ORDER BY name')).rows,
      addScoreKeeper: async (sk) => {
        const r = await pool.query('INSERT INTO score_keepers (name, phone, email, access_token) VALUES ($1,$2,$3,$4) RETURNING id', [sk.name, sk.phone || null, sk.email || null, sk.access_token]);
        return r.rows[0];
      },
      removeScoreKeeper: async (id) => pool.query('DELETE FROM score_keepers WHERE id = $1', [id]),
      getScoreKeeperByToken: async (token) => (await pool.query('SELECT * FROM score_keepers WHERE access_token = $1', [token])).rows[0] || null,

      createLiveGame: async (g) => {
        const r = await pool.query(
          'INSERT INTO live_games (team_event_id, sub_event_id, home_away, opp_team_name, total_innings, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [g.team_event_id || null, g.sub_event_id || null, g.home_away, g.opp_team_name, g.total_innings || 6, 'setup']
        );
        return r.rows[0];
      },
      getLiveGame: async (id) => (await pool.query('SELECT * FROM live_games WHERE id = $1', [id])).rows[0] || null,
      getLiveGameByEvent: async (eventId, subEventId) => {
        if (subEventId) return (await pool.query('SELECT * FROM live_games WHERE sub_event_id = $1 ORDER BY id DESC LIMIT 1', [subEventId])).rows[0] || null;
        return (await pool.query('SELECT * FROM live_games WHERE team_event_id = $1 AND sub_event_id IS NULL ORDER BY id DESC LIMIT 1', [eventId])).rows[0] || null;
      },
      updateGameState: async (id, state) => {
        const fields = [];
        const vals = [];
        let idx = 1;
        for (const [k, v] of Object.entries(state)) {
          fields.push(`${k} = $${idx}`);
          vals.push(v);
          idx++;
        }
        vals.push(id);
        await pool.query(`UPDATE live_games SET ${fields.join(', ')} WHERE id = $${idx}`, vals);
      },
      getAllActiveGames: async () => (await pool.query("SELECT * FROM live_games WHERE status IN ('setup','active') ORDER BY id DESC")).rows,

      setGameRoster: async (gameId, entries) => {
        await pool.query('DELETE FROM game_roster WHERE game_id = $1', [gameId]);
        for (const e of entries) {
          await pool.query('INSERT INTO game_roster (game_id, player_id, batting_order, current_position, is_active, entered_inning) VALUES ($1,$2,$3,$4,$5,$6)',
            [gameId, e.player_id, e.batting_order, e.current_position || null, e.is_active !== undefined ? e.is_active : 1, e.entered_inning || 1]);
        }
      },
      getGameRoster: async (gameId) => (await pool.query('SELECT gr.*, p.player_name, p.jersey_number FROM game_roster gr JOIN players p ON gr.player_id = p.id WHERE gr.game_id = $1 ORDER BY gr.batting_order', [gameId])).rows,
      updateRosterEntry: async (id, data) => {
        const fields = [];
        const vals = [];
        let idx = 1;
        for (const [k, v] of Object.entries(data)) {
          fields.push(`${k} = $${idx}`);
          vals.push(v);
          idx++;
        }
        vals.push(id);
        await pool.query(`UPDATE game_roster SET ${fields.join(', ')} WHERE id = $${idx}`, vals);
      },

      setOppRoster: async (gameId, entries) => {
        await pool.query('DELETE FROM opponent_roster WHERE game_id = $1', [gameId]);
        for (const e of entries) {
          await pool.query('INSERT INTO opponent_roster (game_id, player_name, jersey_number, batting_order, current_position, is_active) VALUES ($1,$2,$3,$4,$5,$6)',
            [gameId, e.player_name, e.jersey_number || null, e.batting_order, e.current_position || null, e.is_active !== undefined ? e.is_active : 1]);
        }
      },
      getOppRoster: async (gameId) => (await pool.query('SELECT * FROM opponent_roster WHERE game_id = $1 ORDER BY batting_order', [gameId])).rows,

      createAtBat: async (ab) => {
        const r = await pool.query(
          `INSERT INTO at_bats (game_id, inning, half, is_our_team, batter_player_id, batter_name, pitcher_player_id, pitcher_name, batting_order_pos, runners_on_base)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [ab.game_id, ab.inning, ab.half, ab.is_our_team, ab.batter_player_id || null, ab.batter_name, ab.pitcher_player_id || null, ab.pitcher_name || null, ab.batting_order_pos, ab.runners_on_base || null]
        );
        return r.rows[0];
      },
      updateAtBat: async (id, data) => {
        const fields = [];
        const vals = [];
        let idx = 1;
        for (const [k, v] of Object.entries(data)) {
          fields.push(`${k} = $${idx}`);
          vals.push(v);
          idx++;
        }
        vals.push(id);
        await pool.query(`UPDATE at_bats SET ${fields.join(', ')} WHERE id = $${idx}`, vals);
      },
      getAtBat: async (id) => (await pool.query('SELECT * FROM at_bats WHERE id = $1', [id])).rows[0] || null,
      getAtBatsForGame: async (gameId) => (await pool.query('SELECT * FROM at_bats WHERE game_id = $1 ORDER BY id', [gameId])).rows,
      getAtBatsForPlayer: async (playerId) => (await pool.query('SELECT ab.*, lg.opp_team_name, lg.started_at FROM at_bats ab JOIN live_games lg ON ab.game_id = lg.id WHERE ab.batter_player_id = $1 AND ab.result IS NOT NULL ORDER BY ab.id', [playerId])).rows,
      deleteAtBat: async (id) => pool.query('DELETE FROM at_bats WHERE id = $1', [id]),

      recordPitch: async (p) => {
        const r = await pool.query(
          `INSERT INTO pitches (game_id, at_bat_id, inning, half, pitcher_player_id, pitcher_name, batter_player_id, batter_name, pitch_number_in_ab, pitch_number_game, result, balls_before, strikes_before, runners_on)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [p.game_id, p.at_bat_id, p.inning, p.half, p.pitcher_player_id || null, p.pitcher_name || null, p.batter_player_id || null, p.batter_name || null, p.pitch_number_in_ab, p.pitch_number_game || 0, p.result, p.balls_before || 0, p.strikes_before || 0, p.runners_on || null]
        );
        return r.rows[0];
      },
      getPitchesForAtBat: async (atBatId) => (await pool.query('SELECT * FROM pitches WHERE at_bat_id = $1 ORDER BY pitch_number_in_ab', [atBatId])).rows,
      getPitchesForGame: async (gameId) => (await pool.query('SELECT * FROM pitches WHERE game_id = $1 ORDER BY id', [gameId])).rows,
      getPitchCountForPitcher: async (gameId, playerId) => {
        const r = await pool.query('SELECT COUNT(*)::int as cnt FROM pitches WHERE game_id = $1 AND pitcher_player_id = $2', [gameId, playerId]);
        return r.rows[0].cnt;
      },
      getLastPitchInAB: async (atBatId) => (await pool.query('SELECT * FROM pitches WHERE at_bat_id = $1 ORDER BY pitch_number_in_ab DESC LIMIT 1', [atBatId])).rows[0] || null,
      deletePitch: async (id) => pool.query('DELETE FROM pitches WHERE id = $1', [id]),
      getPitchesForPitcherSeason: async (playerId) => (await pool.query('SELECT p.*, lg.started_at FROM pitches p JOIN live_games lg ON p.game_id = lg.id WHERE p.pitcher_player_id = $1 ORDER BY p.id', [playerId])).rows,

      addGameChat: async (msg) => {
        const r = await pool.query('INSERT INTO game_chat (game_id, author_name, message) VALUES ($1,$2,$3) RETURNING *', [msg.game_id, msg.author_name, msg.message]);
        return r.rows[0];
      },
      getGameChat: async (gameId, afterId) => {
        if (afterId) return (await pool.query('SELECT * FROM game_chat WHERE game_id = $1 AND id > $2 ORDER BY id', [gameId, afterId])).rows;
        return (await pool.query('SELECT * FROM game_chat WHERE game_id = $1 ORDER BY id DESC LIMIT 50', [gameId])).rows.reverse();
      },

      pushUndo: async (gameId, actionType, actionData, prevState) => {
        const seq = await pool.query('SELECT COALESCE(MAX(sequence_num), 0) + 1 as next FROM game_undo_log WHERE game_id = $1', [gameId]);
        await pool.query('INSERT INTO game_undo_log (game_id, action_type, action_data, prev_game_state, sequence_num) VALUES ($1,$2,$3,$4,$5)',
          [gameId, actionType, actionData || null, prevState || null, seq.rows[0].next]);
      },
      popUndo: async (gameId) => {
        const r = await pool.query('SELECT * FROM game_undo_log WHERE game_id = $1 ORDER BY sequence_num DESC LIMIT 1', [gameId]);
        if (r.rows.length === 0) return null;
        await pool.query('DELETE FROM game_undo_log WHERE id = $1', [r.rows[0].id]);
        return r.rows[0];
      },
      getUndoCount: async (gameId) => {
        const r = await pool.query('SELECT COUNT(*)::int as cnt FROM game_undo_log WHERE game_id = $1', [gameId]);
        return r.rows[0].cnt;
      },
      getAllPrograms: async () => (await pool.query('SELECT * FROM programs ORDER BY created_at DESC')).rows,
      getPublishedPrograms: async () => (await pool.query('SELECT * FROM programs WHERE published = 1 ORDER BY title')).rows,
      getProgram: async (id) => (await pool.query('SELECT * FROM programs WHERE id = $1', [id])).rows[0] || null,
      addProgram: async (p) => (await pool.query('INSERT INTO programs (title, description, author, program_type, schedule_type, published) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [p.title, p.description || null, p.author || null, p.program_type || 'at_home', p.schedule_type || 'weekly', p.published || 0])).rows[0],
      updateProgram: async (id, p) => pool.query('UPDATE programs SET title=$1, description=$2, author=$3, program_type=$4, schedule_type=$5, published=$6 WHERE id=$7', [p.title, p.description || null, p.author || null, p.program_type, p.schedule_type, p.published || 0, id]),
      removeProgram: async (id) => pool.query('DELETE FROM programs WHERE id = $1', [id]),
      getProgramDays: async (programId) => (await pool.query('SELECT * FROM program_days WHERE program_id = $1 ORDER BY sort_order', [programId])).rows,
      addProgramDay: async (d) => (await pool.query('INSERT INTO program_days (program_id, day_label, day_number, sort_order) VALUES ($1,$2,$3,$4) RETURNING id', [d.program_id, d.day_label, d.day_number, d.sort_order])).rows[0],
      updateProgramDay: async (id, d) => pool.query('UPDATE program_days SET day_label=$1, day_number=$2, sort_order=$3 WHERE id=$4', [d.day_label, d.day_number, d.sort_order, id]),
      removeProgramDay: async (id) => pool.query('DELETE FROM program_days WHERE id = $1', [id]),
      getProgramActivities: async (dayId) => (await pool.query('SELECT * FROM program_activities WHERE program_day_id = $1 ORDER BY sort_order', [dayId])).rows,
      addProgramActivity: async (a) => (await pool.query('INSERT INTO program_activities (program_day_id, activity_name, description, instructions, reps, link_url, image_url, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [a.program_day_id, a.activity_name, a.description || null, a.instructions || null, a.reps || null, a.link_url || null, a.image_url || null, a.sort_order])).rows[0],
      updateProgramActivity: async (id, a) => pool.query('UPDATE program_activities SET activity_name=$1, description=$2, instructions=$3, reps=$4, link_url=$5, image_url=$6, sort_order=$7 WHERE id=$8', [a.activity_name, a.description || null, a.instructions || null, a.reps || null, a.link_url || null, a.image_url || null, a.sort_order, id]),
      removeProgramActivity: async (id) => pool.query('DELETE FROM program_activities WHERE id = $1', [id]),
      getProgramAssignments: async (programId) => (await pool.query('SELECT pa.*, p.player_name FROM program_assignments pa JOIN players p ON pa.player_id = p.id WHERE pa.program_id = $1 ORDER BY p.player_name', [programId])).rows,
      getPlayerAssignments: async (playerId) => (await pool.query("SELECT pa.*, pr.title, pr.description, pr.schedule_type FROM program_assignments pa JOIN programs pr ON pa.program_id = pr.id WHERE pa.player_id = $1 ORDER BY pr.title", [playerId])).rows,
      assignProgram: async (a) => pool.query("INSERT INTO program_assignments (program_id, player_id, assigned_by_staff_id, send_reminders, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (program_id, player_id) DO UPDATE SET status = 'active', assigned_by_staff_id = $3, send_reminders = $4, started_at = NOW(), start_date = COALESCE($5, program_assignments.start_date), end_date = COALESCE($6, program_assignments.end_date)", [a.program_id, a.player_id, a.assigned_by_staff_id || null, a.send_reminders ?? 1, a.start_date || null, a.end_date || null]),
      unassignProgram: async (programId, playerId) => pool.query('DELETE FROM program_assignments WHERE program_id = $1 AND player_id = $2', [programId, playerId]),
      updateAssignmentStatus: async (programId, playerId, status) => pool.query('UPDATE program_assignments SET status = $1 WHERE program_id = $2 AND player_id = $3', [status, programId, playerId]),
      updateAssignmentDates: async (programId, playerId, startDate, endDate) => pool.query('UPDATE program_assignments SET start_date = $1, end_date = $2 WHERE program_id = $3 AND player_id = $4', [startDate || null, endDate || null, programId, playerId]),
      updateAllAssignmentDates: async (programId, startDate, endDate) => pool.query('UPDATE program_assignments SET start_date = $1, end_date = $2 WHERE program_id = $3', [startDate || null, endDate || null, programId]),
      getSetting: async (key) => {
        const { rows } = await pool.query('SELECT value FROM site_settings WHERE key = $1', [key]);
        return rows.length > 0 ? rows[0].value : null;
      },
      setSetting: async (key, value) => pool.query('INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, value]),
      updateProgramPositions: async (id, positions) => pool.query('UPDATE programs SET assigned_positions = $1 WHERE id = $2', [positions, id]),
      getConfirmedPlayers: async () => (await pool.query("SELECT * FROM players WHERE status = 'confirmed' ORDER BY player_name")).rows,
      getAllProgramsWithPositions: async () => (await pool.query("SELECT * FROM programs WHERE assigned_positions IS NOT NULL AND assigned_positions != ''")).rows,
      markDayComplete: async (programId, playerId, dayId, weekOf) => pool.query(
        'INSERT INTO program_completions (program_id, player_id, program_day_id, week_of) VALUES ($1,$2,$3,$4) ON CONFLICT (program_id, player_id, program_day_id, week_of) DO UPDATE SET completed_at = NOW()',
        [programId, playerId, dayId, weekOf]
      ),
      unmarkDayComplete: async (programId, playerId, dayId, weekOf) => pool.query(
        'DELETE FROM program_completions WHERE program_id = $1 AND player_id = $2 AND program_day_id = $3 AND week_of = $4',
        [programId, playerId, dayId, weekOf]
      ),
      getCompletions: async (programId, playerId) => (await pool.query('SELECT * FROM program_completions WHERE program_id = $1 AND player_id = $2', [programId, playerId])).rows,
      getCompletionsForProgram: async (programId) => (await pool.query('SELECT * FROM program_completions WHERE program_id = $1', [programId])).rows,
      getCompletionsForWeek: async (programId, weekOf) => (await pool.query('SELECT * FROM program_completions WHERE program_id = $1 AND week_of = $2', [programId, weekOf])).rows,
      getProgramEquipment: async (programId) => (await pool.query('SELECT * FROM program_equipment WHERE program_id = $1 ORDER BY is_required DESC, sort_order', [programId])).rows,
      addProgramEquipment: async (e) => (await pool.query('INSERT INTO program_equipment (program_id, item_name, is_required, buy_url, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id', [e.program_id, e.item_name, e.is_required, e.buy_url || null, e.sort_order || 0])).rows[0],
      updateProgramEquipment: async (id, e) => pool.query('UPDATE program_equipment SET item_name=$1, is_required=$2, buy_url=$3, sort_order=$4 WHERE id=$5', [e.item_name, e.is_required, e.buy_url || null, e.sort_order || 0, id]),
      removeProgramEquipment: async (id) => pool.query('DELETE FROM program_equipment WHERE id = $1', [id]),

      getAllQuizzes: async () => (await pool.query('SELECT * FROM quizzes ORDER BY position, title')).rows,
      getQuiz: async (id) => (await pool.query('SELECT * FROM quizzes WHERE id = $1', [id])).rows[0] || null,
      getQuizzesByPosition: async (pos) => (await pool.query('SELECT * FROM quizzes WHERE position = $1 ORDER BY title', [pos])).rows,
      createQuiz: async (q) => (await pool.query('INSERT INTO quizzes (title, position, description) VALUES ($1,$2,$3) RETURNING id', [q.title, q.position, q.description || null])).rows[0],
      getQuizQuestions: async (quizId) => (await pool.query('SELECT * FROM quiz_questions WHERE quiz_id = $1 ORDER BY sort_order', [quizId])).rows,
      addQuizQuestion: async (q) => (await pool.query('INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_answer, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [q.quiz_id, q.question_text, q.option_a, q.option_b, q.option_c || null, q.option_d || null, q.correct_answer, q.sort_order || 0])).rows[0],
      assignQuiz: async (quizId, playerId) => { try { await pool.query('INSERT INTO quiz_assignments (quiz_id, player_id) VALUES ($1,$2)', [quizId, playerId]); } catch(e) { /* duplicate */ } },
      getQuizAssignments: async (quizId) => (await pool.query('SELECT qa.*, p.player_name, p.parent_phone FROM quiz_assignments qa JOIN players p ON qa.player_id = p.id WHERE qa.quiz_id = $1 ORDER BY p.player_name', [quizId])).rows,
      getPlayerQuizAssignments: async (playerId) => (await pool.query('SELECT qa.*, q.title, q.position, q.description FROM quiz_assignments qa JOIN quizzes q ON qa.quiz_id = q.id WHERE qa.player_id = $1 ORDER BY qa.assigned_at DESC', [playerId])).rows,
      getQuizAttempts: async (quizId, playerId) => (await pool.query('SELECT * FROM quiz_attempts WHERE quiz_id = $1 AND player_id = $2 ORDER BY completed_at DESC', [quizId, playerId])).rows,
      getAllQuizAttempts: async (quizId) => (await pool.query('SELECT qa.*, p.player_name FROM quiz_attempts qa JOIN players p ON qa.player_id = p.id WHERE qa.quiz_id = $1 ORDER BY qa.completed_at DESC', [quizId])).rows,
      addQuizAttempt: async (a) => (await pool.query('INSERT INTO quiz_attempts (quiz_id, player_id, score, total, answers_json) VALUES ($1,$2,$3,$4,$5) RETURNING id', [a.quiz_id, a.player_id, a.score, a.total, a.answers_json || null])).rows[0],
      getQuizAttempt: async (id) => (await pool.query('SELECT qa.*, p.player_name, q.title as quiz_title, q.position as quiz_position FROM quiz_attempts qa JOIN players p ON qa.player_id = p.id JOIN quizzes q ON qa.quiz_id = q.id WHERE qa.id = $1', [id])).rows[0] || null,
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
    try { sqliteDb.exec('ALTER TABLE admins ADD COLUMN email TEXT'); } catch (e) { /* exists */ }

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

    try { sqliteDb.exec('ALTER TABLE practice_drills ADD COLUMN coach_notes TEXT'); } catch (e) { /* exists */ }
    try { sqliteDb.exec('ALTER TABLE practice_drills ADD COLUMN assigned_staff TEXT'); } catch (e) { /* exists */ }

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT
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
      CREATE TABLE IF NOT EXISTS lineup_grid (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_event_id INTEGER REFERENCES team_events(id) ON DELETE CASCADE,
        sub_event_id INTEGER REFERENCES tournament_sub_events(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        batting_order INTEGER NOT NULL,
        inning INTEGER NOT NULL,
        position_number INTEGER,
        status TEXT NOT NULL DEFAULT 'field'
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

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS parent_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    try { sqliteDb.exec('ALTER TABLE parent_accounts ADD COLUMN last_login_at TEXT'); } catch (e) { /* exists */ }
    try { sqliteDb.exec("ALTER TABLE parent_accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'parent'"); } catch (e) { /* exists */ }
    try { sqliteDb.exec('ALTER TABLE parent_accounts ADD COLUMN approved INTEGER NOT NULL DEFAULT 1'); } catch (e) { /* exists */ }
    try { sqliteDb.exec('ALTER TABLE parent_accounts ADD COLUMN username TEXT UNIQUE'); } catch (e) { /* exists */ }

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS player_parents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES parent_accounts(id) ON DELETE CASCADE,
        UNIQUE(player_id, account_id)
      )
    `);

    const migCount = sqliteDb.prepare('SELECT COUNT(*) as c FROM player_parents').get();
    if (migCount.c === 0) {
      const accts = sqliteDb.prepare('SELECT id, phone FROM parent_accounts').all();
      for (const acct of accts) {
        const linked = sqliteDb.prepare('SELECT id FROM players WHERE parent_phone = ?').all(acct.phone);
        for (const p of linked) {
          sqliteDb.prepare('INSERT OR IGNORE INTO player_parents (player_id, account_id) VALUES (?, ?)').run(p.id, acct.id);
        }
      }
    }

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS team_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        author_name TEXT NOT NULL,
        author_type TEXT NOT NULL DEFAULT 'parent',
        message TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS saved_locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        location_name TEXT NOT NULL,
        address TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    try { sqliteDb.exec('ALTER TABLE team_events ADD COLUMN opponent_name TEXT'); } catch (e) { /* exists */ }
    try { sqliteDb.exec('ALTER TABLE team_events ADD COLUMN our_score INTEGER'); } catch (e) { /* exists */ }
    try { sqliteDb.exec('ALTER TABLE team_events ADD COLUMN opponent_score INTEGER'); } catch (e) { /* exists */ }
    try { sqliteDb.exec('ALTER TABLE team_messages ADD COLUMN parent_id INTEGER REFERENCES team_messages(id) ON DELETE CASCADE'); } catch (e) { /* exists */ }

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS board_reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES team_messages(id) ON DELETE CASCADE,
        author_name TEXT NOT NULL,
        reaction_type TEXT NOT NULL CHECK (reaction_type IN ('up', 'down')),
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(message_id, author_name, reaction_type)
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS score_keepers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        access_token TEXT NOT NULL UNIQUE,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS live_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_event_id INTEGER REFERENCES team_events(id) ON DELETE SET NULL,
        sub_event_id INTEGER REFERENCES tournament_sub_events(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'setup',
        home_away TEXT NOT NULL DEFAULT 'home',
        current_inning INTEGER NOT NULL DEFAULT 1,
        current_half TEXT NOT NULL DEFAULT 'top',
        outs INTEGER NOT NULL DEFAULT 0,
        our_score INTEGER NOT NULL DEFAULT 0,
        opp_score INTEGER NOT NULL DEFAULT 0,
        balls INTEGER NOT NULL DEFAULT 0,
        strikes INTEGER NOT NULL DEFAULT 0,
        runner_first TEXT,
        runner_second TEXT,
        runner_third TEXT,
        current_batter_us INTEGER NOT NULL DEFAULT 0,
        current_batter_opp INTEGER NOT NULL DEFAULT 0,
        current_pitcher_us INTEGER,
        opp_pitcher_name TEXT,
        opp_team_name TEXT NOT NULL DEFAULT 'Opponent',
        current_at_bat_id INTEGER,
        total_innings INTEGER NOT NULL DEFAULT 6,
        started_at TEXT,
        ended_at TEXT,
        active_scorer_name TEXT,
        active_scorer_at TEXT
      )
    `);

    try { sqliteDb.exec('ALTER TABLE live_games ADD COLUMN active_scorer_name TEXT'); } catch (e) {}
    try { sqliteDb.exec('ALTER TABLE live_games ADD COLUMN active_scorer_at TEXT'); } catch (e) {}

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS game_roster (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        batting_order INTEGER NOT NULL,
        current_position INTEGER,
        is_active INTEGER NOT NULL DEFAULT 1,
        entered_inning INTEGER NOT NULL DEFAULT 1,
        exited_inning INTEGER
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS opponent_roster (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
        player_name TEXT NOT NULL,
        jersey_number TEXT,
        batting_order INTEGER NOT NULL,
        current_position INTEGER,
        is_active INTEGER NOT NULL DEFAULT 1
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS at_bats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
        inning INTEGER NOT NULL,
        half TEXT NOT NULL,
        is_our_team INTEGER NOT NULL,
        batter_player_id INTEGER,
        batter_name TEXT NOT NULL,
        pitcher_player_id INTEGER,
        pitcher_name TEXT,
        batting_order_pos INTEGER NOT NULL,
        result TEXT,
        hit_type TEXT,
        is_hard_contact INTEGER,
        rbi_count INTEGER NOT NULL DEFAULT 0,
        outs_on_play INTEGER NOT NULL DEFAULT 0,
        fielders_involved TEXT,
        error_position INTEGER,
        error_player_id INTEGER,
        total_pitches INTEGER NOT NULL DEFAULT 0,
        balls_in_count INTEGER NOT NULL DEFAULT 0,
        strikes_in_count INTEGER NOT NULL DEFAULT 0,
        runners_on_base TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS pitches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
        at_bat_id INTEGER NOT NULL REFERENCES at_bats(id) ON DELETE CASCADE,
        inning INTEGER NOT NULL,
        half TEXT NOT NULL,
        pitcher_player_id INTEGER,
        pitcher_name TEXT,
        batter_player_id INTEGER,
        batter_name TEXT,
        pitch_number_in_ab INTEGER NOT NULL,
        pitch_number_game INTEGER NOT NULL DEFAULT 0,
        result TEXT NOT NULL,
        balls_before INTEGER NOT NULL DEFAULT 0,
        strikes_before INTEGER NOT NULL DEFAULT 0,
        runners_on TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS game_chat (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
        author_name TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS game_undo_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
        action_type TEXT NOT NULL,
        action_data TEXT,
        prev_game_state TEXT,
        sequence_num INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS programs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        author TEXT,
        program_type TEXT NOT NULL DEFAULT 'at_home',
        schedule_type TEXT NOT NULL DEFAULT 'weekly',
        published INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS program_days (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
        day_label TEXT NOT NULL,
        day_number INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS program_activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        program_day_id INTEGER NOT NULL REFERENCES program_days(id) ON DELETE CASCADE,
        activity_name TEXT NOT NULL,
        description TEXT,
        instructions TEXT,
        reps TEXT,
        link_url TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    try { sqliteDb.exec('ALTER TABLE program_activities ADD COLUMN link_url TEXT'); } catch (e) {}
    try { sqliteDb.exec('ALTER TABLE program_activities ADD COLUMN image_url TEXT'); } catch (e) {}

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS program_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        assigned_by_staff_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        send_reminders INTEGER NOT NULL DEFAULT 1,
        started_at TEXT DEFAULT (datetime('now')),
        UNIQUE(program_id, player_id)
      )
    `);

    try { sqliteDb.exec('ALTER TABLE programs ADD COLUMN assigned_positions TEXT'); } catch (e) { /* exists */ }
    try { sqliteDb.exec('ALTER TABLE program_assignments ADD COLUMN start_date TEXT'); } catch (e) { /* exists */ }
    try { sqliteDb.exec('ALTER TABLE program_assignments ADD COLUMN end_date TEXT'); } catch (e) { /* exists */ }

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS program_completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        program_day_id INTEGER NOT NULL REFERENCES program_days(id) ON DELETE CASCADE,
        completed_at TEXT DEFAULT (datetime('now')),
        week_of TEXT,
        UNIQUE(program_id, player_id, program_day_id, week_of)
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS program_equipment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
        item_name TEXT NOT NULL,
        is_required INTEGER NOT NULL DEFAULT 1,
        buy_url TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS program_reminder_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        program_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        sent_date TEXT NOT NULL,
        sent_at TEXT DEFAULT (datetime('now')),
        UNIQUE(program_id, player_id, sent_date)
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS quizzes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        position TEXT NOT NULL,
        description TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS quiz_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        question_text TEXT NOT NULL,
        option_a TEXT NOT NULL,
        option_b TEXT NOT NULL,
        option_c TEXT,
        option_d TEXT,
        correct_answer TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS quiz_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        assigned_at TEXT DEFAULT (datetime('now')),
        UNIQUE(quiz_id, player_id)
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS quiz_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        score INTEGER NOT NULL,
        total INTEGER NOT NULL,
        answers_json TEXT,
        started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT DEFAULT (datetime('now'))
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
            baseball_iq=?, contacts=?, jersey_number=?, coach_assigned_positions=?,
            profile_updated_at=?
          WHERE id=?`
        ).run(
          data.birthdate, data.best_positions, data.favorite_positions,
          data.arm_strength, data.throwing_accuracy, data.contact_hitting, data.power_hitting,
          data.pitching, data.infield_defense, data.outfield_defense, data.catcher_skill,
          data.baseball_iq, data.contacts, data.jersey_number, data.coach_assigned_positions,
          new Date().toISOString(), id
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
        'INSERT INTO team_events (event_type, title, start_date, start_time, end_date, end_time, location_name, address, notes, hotel_info, carpool_info, opponent_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(e.event_type, e.title, e.start_date, e.start_time, e.end_date, e.end_time, e.location_name, e.address, e.notes, e.hotel_info, e.carpool_info, e.opponent_name || null),
      updateTeamEvent: async (id, e) => sqliteDb.prepare(
        'UPDATE team_events SET event_type=?, title=?, start_date=?, start_time=?, end_date=?, end_time=?, location_name=?, address=?, notes=?, hotel_info=?, carpool_info=?, opponent_name=? WHERE id=?'
      ).run(e.event_type, e.title, e.start_date, e.start_time, e.end_date, e.end_time, e.location_name, e.address, e.notes, e.hotel_info, e.carpool_info, e.opponent_name || null, id),
      removeTeamEvent: async (id) => sqliteDb.prepare('DELETE FROM team_events WHERE id = ?').run(id),
      updateBattingAll: async (id, val) => sqliteDb.prepare('UPDATE team_events SET batting_all = ? WHERE id = ?').run(val ? 1 : 0, id),
      getDrills: async (eventId) => sqliteDb.prepare('SELECT * FROM practice_drills WHERE team_event_id = ? ORDER BY sort_order').all(eventId),
      addDrill: async (d) => {
        const r = sqliteDb.prepare('INSERT INTO practice_drills (team_event_id, drill_name, description, duration_minutes, sort_order, coach_notes, assigned_staff) VALUES (?,?,?,?,?,?,?)').run(d.team_event_id, d.drill_name, d.description, d.duration_minutes, d.sort_order, d.coach_notes || null, d.assigned_staff || null);
        return { id: r.lastInsertRowid };
      },
      updateDrill: async (id, d) => sqliteDb.prepare('UPDATE practice_drills SET drill_name=?, description=?, duration_minutes=?, sort_order=?, coach_notes=? , assigned_staff=? WHERE id=?').run(d.drill_name, d.description, d.duration_minutes, d.sort_order, d.coach_notes || null, d.assigned_staff || null, id),
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
      getLineupGrid: async (eventId, subEventId) => {
        if (eventId) return sqliteDb.prepare('SELECT g.*, p.player_name, p.best_positions, p.jersey_number FROM lineup_grid g JOIN players p ON g.player_id = p.id WHERE g.team_event_id = ? ORDER BY g.batting_order, g.inning').all(eventId);
        return sqliteDb.prepare('SELECT g.*, p.player_name, p.best_positions, p.jersey_number FROM lineup_grid g JOIN players p ON g.player_id = p.id WHERE g.sub_event_id = ? ORDER BY g.batting_order, g.inning').all(subEventId);
      },
      saveLineupGrid: async (eventId, subEventId, entries) => {
        if (eventId) sqliteDb.prepare('DELETE FROM lineup_grid WHERE team_event_id = ?').run(eventId);
        else sqliteDb.prepare('DELETE FROM lineup_grid WHERE sub_event_id = ?').run(subEventId);
        const ins = sqliteDb.prepare('INSERT INTO lineup_grid (team_event_id, sub_event_id, player_id, batting_order, inning, position_number, status) VALUES (?,?,?,?,?,?,?)');
        for (const e of entries) {
          ins.run(eventId || null, subEventId || null, e.player_id, e.batting_order, e.inning, e.position_number || null, e.status || 'field');
        }
      },
      getAdminByUsername: async (username) => sqliteDb.prepare('SELECT * FROM admins WHERE username = ?').get(username) || null,
      getAdminById: async (id) => sqliteDb.prepare('SELECT * FROM admins WHERE id = ?').get(id) || null,
      getAllAdmins: async () => sqliteDb.prepare('SELECT id, username, created_at FROM admins ORDER BY created_at').all(),
      countAdmins: async () => sqliteDb.prepare('SELECT COUNT(*) as c FROM admins').get().c,
      createAdmin: async (username, passwordHash) => sqliteDb.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, passwordHash),
      updateAdminPassword: async (id, passwordHash) => sqliteDb.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(passwordHash, id),
      updateAdminEmail: async (id, email) => sqliteDb.prepare('UPDATE admins SET email = ? WHERE id = ?').run(email, id),
      getAdminByEmail: async (email) => sqliteDb.prepare('SELECT * FROM admins WHERE LOWER(email) = LOWER(?)').get(email) || null,
      removeAdmin: async (id) => sqliteDb.prepare('DELETE FROM admins WHERE id = ?').run(id),
      getRsvp: async (eventId, playerId) => sqliteDb.prepare('SELECT * FROM rsvps WHERE team_event_id = ? AND player_id = ?').get(eventId, playerId) || null,
      getRsvpsForEvent: async (eventId) => sqliteDb.prepare('SELECT r.*, p.player_name, p.parent_name FROM rsvps r JOIN players p ON r.player_id = p.id WHERE r.team_event_id = ? ORDER BY p.player_name').all(eventId),
      getRsvpCountsAll: async () => sqliteDb.prepare("SELECT team_event_id, status, COUNT(*) as cnt FROM rsvps GROUP BY team_event_id, status").all(),
      clearGameScore: async (id) => sqliteDb.prepare('UPDATE team_events SET our_score = NULL, opponent_score = NULL WHERE id = ?').run(id),
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
      hasProgramReminderBeenSent: async (sentDate) => {
        const row = sqliteDb.prepare('SELECT COUNT(*) as c FROM program_reminder_log WHERE sent_date = ?').get(sentDate);
        return row.c > 0;
      },
      logProgramReminder: async (programId, playerId, sentDate) => {
        sqliteDb.prepare('INSERT OR IGNORE INTO program_reminder_log (program_id, player_id, sent_date) VALUES (?,?,?)').run(programId, playerId, sentDate);
      },
      updateJerseyNumber: async (id, number) => sqliteDb.prepare('UPDATE players SET jersey_number = ? WHERE id = ?').run(number, id),
      getParentAccountByPhone: async (phone) => sqliteDb.prepare('SELECT * FROM parent_accounts WHERE phone = ?').get(phone) || null,
      getParentAccountByUsername: async (username) => sqliteDb.prepare('SELECT * FROM parent_accounts WHERE LOWER(username) = LOWER(?)').get(username) || null,
      createParentAccount: async (phone, displayName, passwordHash) => sqliteDb.prepare('INSERT INTO parent_accounts (phone, display_name, password_hash) VALUES (?, ?, ?)').run(phone, displayName, passwordHash),
      getAllParentAccounts: async () => sqliteDb.prepare('SELECT * FROM parent_accounts ORDER BY display_name').all(),
      getParentAccountById: async (id) => sqliteDb.prepare('SELECT * FROM parent_accounts WHERE id = ?').get(id) || null,
      updateParentAccountPassword: async (id, passwordHash) => sqliteDb.prepare('UPDATE parent_accounts SET password_hash = ? WHERE id = ?').run(passwordHash, id),
      updateParentAccountName: async (id, displayName) => sqliteDb.prepare('UPDATE parent_accounts SET display_name = ? WHERE id = ?').run(displayName, id),
      updateParentAccountPhone: async (id, phone) => sqliteDb.prepare('UPDATE parent_accounts SET phone = ? WHERE id = ?').run(phone, id),
      updateParentAccountUsername: async (id, username) => sqliteDb.prepare('UPDATE parent_accounts SET username = ? WHERE id = ?').run(username || null, id),
      updateParentLoginTime: async (phone) => sqliteDb.prepare("UPDATE parent_accounts SET last_login_at = datetime('now') WHERE phone = ?").run(phone),
      deleteParentAccount: async (id) => sqliteDb.prepare('DELETE FROM parent_accounts WHERE id = ?').run(id),
      updatePlayerParentPhone: async (playerId, phone) => sqliteDb.prepare('UPDATE players SET parent_phone = ? WHERE id = ?').run(phone, playerId),
      linkPlayerToAccount: async (playerId, accountId) => sqliteDb.prepare('INSERT OR IGNORE INTO player_parents (player_id, account_id) VALUES (?, ?)').run(playerId, accountId),
      unlinkPlayerFromAccount: async (playerId, accountId) => sqliteDb.prepare('DELETE FROM player_parents WHERE player_id = ? AND account_id = ?').run(playerId, accountId),
      getLinkedPlayersByAccount: async (accountId) => sqliteDb.prepare('SELECT p.* FROM players p JOIN player_parents pp ON p.id = pp.player_id WHERE pp.account_id = ? ORDER BY p.player_name').all(accountId),
      getLinkedAccountsByPlayer: async (playerId) => sqliteDb.prepare('SELECT pa.* FROM parent_accounts pa JOIN player_parents pp ON pa.id = pp.account_id WHERE pp.player_id = ? ORDER BY pa.display_name').all(playerId),
      getAllPlayerParentLinks: async () => sqliteDb.prepare('SELECT pp.*, p.player_name, pa.display_name, pa.phone, pa.role FROM player_parents pp JOIN players p ON pp.player_id = p.id JOIN parent_accounts pa ON pp.account_id = pa.id ORDER BY p.player_name').all(),
      updateAccountRole: async (id, role) => sqliteDb.prepare('UPDATE parent_accounts SET role = ? WHERE id = ?').run(role, id),
      updateAccountApproved: async (id, approved) => sqliteDb.prepare('UPDATE parent_accounts SET approved = ? WHERE id = ?').run(approved ? 1 : 0, id),
      getPendingFanAccounts: async () => {
        const fans = sqliteDb.prepare("SELECT * FROM parent_accounts WHERE role = 'fan' AND approved = 0 ORDER BY created_at DESC").all();
        for (const f of fans) { f.player_ids = sqliteDb.prepare('SELECT player_id FROM player_parents WHERE account_id = ?').all(f.id).map(r => r.player_id); }
        return fans;
      },
      createParentAccountFull: async (phone, displayName, passwordHash, role, approved) => {
        const r = sqliteDb.prepare('INSERT INTO parent_accounts (phone, display_name, password_hash, role, approved) VALUES (?, ?, ?, ?, ?)').run(phone, displayName, passwordHash, role, approved ? 1 : 0);
        return { id: r.lastInsertRowid };
      },
      updateGameScore: async (id, ourScore, opponentScore) => sqliteDb.prepare('UPDATE team_events SET our_score = ?, opponent_score = ? WHERE id = ?').run(ourScore, opponentScore, id),
      clearLineupGrid: async (eventId, subEventId) => {
        if (eventId) {
          sqliteDb.prepare('DELETE FROM lineup_grid WHERE team_event_id = ?').run(eventId);
          sqliteDb.prepare('DELETE FROM game_lineups WHERE team_event_id = ?').run(eventId);
        } else {
          sqliteDb.prepare('DELETE FROM lineup_grid WHERE sub_event_id = ?').run(subEventId);
          sqliteDb.prepare('DELETE FROM game_lineups WHERE sub_event_id = ?').run(subEventId);
        }
      },
      clearPlayerFromLineupGrid: async (eventId, subEventId, playerId) => {
        if (eventId) sqliteDb.prepare('DELETE FROM lineup_grid WHERE team_event_id = ? AND player_id = ?').run(eventId, playerId);
        else sqliteDb.prepare('DELETE FROM lineup_grid WHERE sub_event_id = ? AND player_id = ?').run(subEventId, playerId);
      },
      getAllMessages: async () => sqliteDb.prepare('SELECT m.*, (SELECT COUNT(*) FROM team_messages r WHERE r.parent_id = m.id) as reply_count FROM team_messages m WHERE m.parent_id IS NULL ORDER BY m.pinned DESC, m.created_at DESC').all(),
      getTopicReplies: async (topicId) => sqliteDb.prepare('SELECT * FROM team_messages WHERE parent_id = ? ORDER BY created_at ASC').all(topicId),
      addMessage: async (m) => sqliteDb.prepare('INSERT INTO team_messages (author_name, author_type, message, parent_id) VALUES (?,?,?,?)').run(m.author_name, m.author_type, m.message, m.parent_id || null),
      removeMessage: async (id) => sqliteDb.prepare('DELETE FROM team_messages WHERE id = ?').run(id),
      togglePinMessage: async (id) => sqliteDb.prepare('UPDATE team_messages SET pinned = CASE WHEN pinned = 1 THEN 0 ELSE 1 END WHERE id = ?').run(id),
      toggleReaction: async (messageId, authorName, reactionType) => {
        const existing = sqliteDb.prepare('SELECT id FROM board_reactions WHERE message_id = ? AND author_name = ? AND reaction_type = ?').get(messageId, authorName, reactionType);
        if (existing) {
          sqliteDb.prepare('DELETE FROM board_reactions WHERE id = ?').run(existing.id);
        } else {
          sqliteDb.prepare('DELETE FROM board_reactions WHERE message_id = ? AND author_name = ?').run(messageId, authorName);
          sqliteDb.prepare('INSERT INTO board_reactions (message_id, author_name, reaction_type) VALUES (?, ?, ?)').run(messageId, authorName, reactionType);
        }
      },
      getReactionsForMessages: async (messageIds) => {
        if (!messageIds.length) return {};
        const placeholders = messageIds.map(() => '?').join(',');
        const rows = sqliteDb.prepare(`SELECT message_id, reaction_type, COUNT(*) as cnt, GROUP_CONCAT(author_name) as authors FROM board_reactions WHERE message_id IN (${placeholders}) GROUP BY message_id, reaction_type`).all(...messageIds);
        const result = {};
        for (const r of rows) {
          if (!result[r.message_id]) result[r.message_id] = { up: 0, down: 0, upAuthors: [], downAuthors: [] };
          result[r.message_id][r.reaction_type] = r.cnt;
          result[r.message_id][r.reaction_type + 'Authors'] = r.authors ? r.authors.split(',') : [];
        }
        return result;
      },
      getAllSavedLocations: async () => sqliteDb.prepare('SELECT * FROM saved_locations ORDER BY location_name').all(),
      addSavedLocation: async (name, address) => sqliteDb.prepare('INSERT INTO saved_locations (location_name, address) VALUES (?, ?)').run(name, address),
      removeSavedLocation: async (id) => sqliteDb.prepare('DELETE FROM saved_locations WHERE id = ?').run(id),

      getAllScoreKeepers: async () => sqliteDb.prepare('SELECT * FROM score_keepers ORDER BY name').all(),
      addScoreKeeper: async (sk) => {
        const r = sqliteDb.prepare('INSERT INTO score_keepers (name, phone, email, access_token) VALUES (?,?,?,?)').run(sk.name, sk.phone || null, sk.email || null, sk.access_token);
        return { id: r.lastInsertRowid };
      },
      removeScoreKeeper: async (id) => sqliteDb.prepare('DELETE FROM score_keepers WHERE id = ?').run(id),
      getScoreKeeperByToken: async (token) => sqliteDb.prepare('SELECT * FROM score_keepers WHERE access_token = ?').get(token) || null,

      createLiveGame: async (g) => {
        const r = sqliteDb.prepare('INSERT INTO live_games (team_event_id, sub_event_id, home_away, opp_team_name, total_innings, status) VALUES (?,?,?,?,?,?)').run(g.team_event_id || null, g.sub_event_id || null, g.home_away, g.opp_team_name, g.total_innings || 6, 'setup');
        return { id: r.lastInsertRowid };
      },
      getLiveGame: async (id) => sqliteDb.prepare('SELECT * FROM live_games WHERE id = ?').get(id) || null,
      getLiveGameByEvent: async (eventId, subEventId) => {
        if (subEventId) return sqliteDb.prepare('SELECT * FROM live_games WHERE sub_event_id = ? ORDER BY id DESC LIMIT 1').get(subEventId) || null;
        return sqliteDb.prepare('SELECT * FROM live_games WHERE team_event_id = ? AND sub_event_id IS NULL ORDER BY id DESC LIMIT 1').get(eventId) || null;
      },
      updateGameState: async (id, state) => {
        const fields = [];
        const vals = [];
        for (const [k, v] of Object.entries(state)) {
          fields.push(`${k} = ?`);
          vals.push(v);
        }
        vals.push(id);
        sqliteDb.prepare(`UPDATE live_games SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
      },
      getAllActiveGames: async () => sqliteDb.prepare("SELECT * FROM live_games WHERE status IN ('setup','active') ORDER BY id DESC").all(),

      setGameRoster: async (gameId, entries) => {
        sqliteDb.prepare('DELETE FROM game_roster WHERE game_id = ?').run(gameId);
        const ins = sqliteDb.prepare('INSERT INTO game_roster (game_id, player_id, batting_order, current_position, is_active, entered_inning) VALUES (?,?,?,?,?,?)');
        for (const e of entries) {
          ins.run(gameId, e.player_id, e.batting_order, e.current_position || null, e.is_active !== undefined ? e.is_active : 1, e.entered_inning || 1);
        }
      },
      getGameRoster: async (gameId) => sqliteDb.prepare('SELECT gr.*, p.player_name, p.jersey_number FROM game_roster gr JOIN players p ON gr.player_id = p.id WHERE gr.game_id = ? ORDER BY gr.batting_order').all(gameId),
      updateRosterEntry: async (id, data) => {
        const fields = [];
        const vals = [];
        for (const [k, v] of Object.entries(data)) {
          fields.push(`${k} = ?`);
          vals.push(v);
        }
        vals.push(id);
        sqliteDb.prepare(`UPDATE game_roster SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
      },

      setOppRoster: async (gameId, entries) => {
        sqliteDb.prepare('DELETE FROM opponent_roster WHERE game_id = ?').run(gameId);
        const ins = sqliteDb.prepare('INSERT INTO opponent_roster (game_id, player_name, jersey_number, batting_order, current_position, is_active) VALUES (?,?,?,?,?,?)');
        for (const e of entries) {
          ins.run(gameId, e.player_name, e.jersey_number || null, e.batting_order, e.current_position || null, e.is_active !== undefined ? e.is_active : 1);
        }
      },
      getOppRoster: async (gameId) => sqliteDb.prepare('SELECT * FROM opponent_roster WHERE game_id = ? ORDER BY batting_order').all(gameId),

      createAtBat: async (ab) => {
        const r = sqliteDb.prepare(
          'INSERT INTO at_bats (game_id, inning, half, is_our_team, batter_player_id, batter_name, pitcher_player_id, pitcher_name, batting_order_pos, runners_on_base) VALUES (?,?,?,?,?,?,?,?,?,?)'
        ).run(ab.game_id, ab.inning, ab.half, ab.is_our_team, ab.batter_player_id || null, ab.batter_name, ab.pitcher_player_id || null, ab.pitcher_name || null, ab.batting_order_pos, ab.runners_on_base || null);
        return { id: r.lastInsertRowid };
      },
      updateAtBat: async (id, data) => {
        const fields = [];
        const vals = [];
        for (const [k, v] of Object.entries(data)) {
          fields.push(`${k} = ?`);
          vals.push(v);
        }
        vals.push(id);
        sqliteDb.prepare(`UPDATE at_bats SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
      },
      getAtBat: async (id) => sqliteDb.prepare('SELECT * FROM at_bats WHERE id = ?').get(id) || null,
      getAtBatsForGame: async (gameId) => sqliteDb.prepare('SELECT * FROM at_bats WHERE game_id = ? ORDER BY id').all(gameId),
      getAtBatsForPlayer: async (playerId) => sqliteDb.prepare('SELECT ab.*, lg.opp_team_name, lg.started_at FROM at_bats ab JOIN live_games lg ON ab.game_id = lg.id WHERE ab.batter_player_id = ? AND ab.result IS NOT NULL ORDER BY ab.id').all(playerId),
      deleteAtBat: async (id) => sqliteDb.prepare('DELETE FROM at_bats WHERE id = ?').run(id),

      recordPitch: async (p) => {
        const r = sqliteDb.prepare(
          'INSERT INTO pitches (game_id, at_bat_id, inning, half, pitcher_player_id, pitcher_name, batter_player_id, batter_name, pitch_number_in_ab, pitch_number_game, result, balls_before, strikes_before, runners_on) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).run(p.game_id, p.at_bat_id, p.inning, p.half, p.pitcher_player_id || null, p.pitcher_name || null, p.batter_player_id || null, p.batter_name || null, p.pitch_number_in_ab, p.pitch_number_game || 0, p.result, p.balls_before || 0, p.strikes_before || 0, p.runners_on || null);
        return { id: r.lastInsertRowid };
      },
      getPitchesForAtBat: async (atBatId) => sqliteDb.prepare('SELECT * FROM pitches WHERE at_bat_id = ? ORDER BY pitch_number_in_ab').all(atBatId),
      getPitchesForGame: async (gameId) => sqliteDb.prepare('SELECT * FROM pitches WHERE game_id = ? ORDER BY id').all(gameId),
      getPitchCountForPitcher: async (gameId, playerId) => {
        const r = sqliteDb.prepare('SELECT COUNT(*) as cnt FROM pitches WHERE game_id = ? AND pitcher_player_id = ?').get(gameId, playerId);
        return r.cnt;
      },
      getLastPitchInAB: async (atBatId) => sqliteDb.prepare('SELECT * FROM pitches WHERE at_bat_id = ? ORDER BY pitch_number_in_ab DESC LIMIT 1').get(atBatId) || null,
      deletePitch: async (id) => sqliteDb.prepare('DELETE FROM pitches WHERE id = ?').run(id),
      getPitchesForPitcherSeason: async (playerId) => sqliteDb.prepare('SELECT p.*, lg.started_at FROM pitches p JOIN live_games lg ON p.game_id = lg.id WHERE p.pitcher_player_id = ? ORDER BY p.id').all(playerId),

      addGameChat: async (msg) => {
        const r = sqliteDb.prepare('INSERT INTO game_chat (game_id, author_name, message) VALUES (?,?,?)').run(msg.game_id, msg.author_name, msg.message);
        return { id: r.lastInsertRowid, game_id: msg.game_id, author_name: msg.author_name, message: msg.message, created_at: new Date().toISOString() };
      },
      getGameChat: async (gameId, afterId) => {
        if (afterId) return sqliteDb.prepare('SELECT * FROM game_chat WHERE game_id = ? AND id > ? ORDER BY id').all(gameId, afterId);
        return sqliteDb.prepare('SELECT * FROM game_chat WHERE game_id = ? ORDER BY id DESC LIMIT 50').all(gameId).reverse();
      },

      pushUndo: async (gameId, actionType, actionData, prevState) => {
        const seq = sqliteDb.prepare('SELECT COALESCE(MAX(sequence_num), 0) + 1 as next FROM game_undo_log WHERE game_id = ?').get(gameId);
        sqliteDb.prepare('INSERT INTO game_undo_log (game_id, action_type, action_data, prev_game_state, sequence_num) VALUES (?,?,?,?,?)').run(gameId, actionType, actionData || null, prevState || null, seq.next);
      },
      popUndo: async (gameId) => {
        const row = sqliteDb.prepare('SELECT * FROM game_undo_log WHERE game_id = ? ORDER BY sequence_num DESC LIMIT 1').get(gameId);
        if (!row) return null;
        sqliteDb.prepare('DELETE FROM game_undo_log WHERE id = ?').run(row.id);
        return row;
      },
      getUndoCount: async (gameId) => {
        const r = sqliteDb.prepare('SELECT COUNT(*) as cnt FROM game_undo_log WHERE game_id = ?').get(gameId);
        return r.cnt;
      },
      getAllPrograms: async () => sqliteDb.prepare('SELECT * FROM programs ORDER BY created_at DESC').all(),
      getPublishedPrograms: async () => sqliteDb.prepare('SELECT * FROM programs WHERE published = 1 ORDER BY title').all(),
      getProgram: async (id) => sqliteDb.prepare('SELECT * FROM programs WHERE id = ?').get(id) || null,
      addProgram: async (p) => {
        const r = sqliteDb.prepare('INSERT INTO programs (title, description, author, program_type, schedule_type, published) VALUES (?,?,?,?,?,?)').run(p.title, p.description || null, p.author || null, p.program_type || 'at_home', p.schedule_type || 'weekly', p.published || 0);
        return { id: r.lastInsertRowid };
      },
      updateProgram: async (id, p) => sqliteDb.prepare('UPDATE programs SET title=?, description=?, author=?, program_type=?, schedule_type=?, published=? WHERE id=?').run(p.title, p.description || null, p.author || null, p.program_type, p.schedule_type, p.published || 0, id),
      removeProgram: async (id) => sqliteDb.prepare('DELETE FROM programs WHERE id = ?').run(id),
      getProgramDays: async (programId) => sqliteDb.prepare('SELECT * FROM program_days WHERE program_id = ? ORDER BY sort_order').all(programId),
      addProgramDay: async (d) => {
        const r = sqliteDb.prepare('INSERT INTO program_days (program_id, day_label, day_number, sort_order) VALUES (?,?,?,?)').run(d.program_id, d.day_label, d.day_number, d.sort_order);
        return { id: r.lastInsertRowid };
      },
      updateProgramDay: async (id, d) => sqliteDb.prepare('UPDATE program_days SET day_label=?, day_number=?, sort_order=? WHERE id=?').run(d.day_label, d.day_number, d.sort_order, id),
      removeProgramDay: async (id) => sqliteDb.prepare('DELETE FROM program_days WHERE id = ?').run(id),
      getProgramActivities: async (dayId) => sqliteDb.prepare('SELECT * FROM program_activities WHERE program_day_id = ? ORDER BY sort_order').all(dayId),
      addProgramActivity: async (a) => {
        const r = sqliteDb.prepare('INSERT INTO program_activities (program_day_id, activity_name, description, instructions, reps, link_url, image_url, sort_order) VALUES (?,?,?,?,?,?,?,?)').run(a.program_day_id, a.activity_name, a.description || null, a.instructions || null, a.reps || null, a.link_url || null, a.image_url || null, a.sort_order);
        return { id: r.lastInsertRowid };
      },
      updateProgramActivity: async (id, a) => sqliteDb.prepare('UPDATE program_activities SET activity_name=?, description=?, instructions=?, reps=?, link_url=?, image_url=?, sort_order=? WHERE id=?').run(a.activity_name, a.description || null, a.instructions || null, a.reps || null, a.link_url || null, a.image_url || null, a.sort_order, id),
      removeProgramActivity: async (id) => sqliteDb.prepare('DELETE FROM program_activities WHERE id = ?').run(id),
      getProgramAssignments: async (programId) => sqliteDb.prepare('SELECT pa.*, p.player_name FROM program_assignments pa JOIN players p ON pa.player_id = p.id WHERE pa.program_id = ? ORDER BY p.player_name').all(programId),
      getPlayerAssignments: async (playerId) => sqliteDb.prepare("SELECT pa.*, pr.title, pr.description, pr.schedule_type FROM program_assignments pa JOIN programs pr ON pa.program_id = pr.id WHERE pa.player_id = ? ORDER BY pr.title").all(playerId),
      assignProgram: async (a) => {
        const existing = sqliteDb.prepare('SELECT start_date, end_date FROM program_assignments WHERE program_id = ? AND player_id = ?').get(a.program_id, a.player_id);
        sqliteDb.prepare('DELETE FROM program_assignments WHERE program_id = ? AND player_id = ?').run(a.program_id, a.player_id);
        sqliteDb.prepare('INSERT INTO program_assignments (program_id, player_id, assigned_by_staff_id, send_reminders, start_date, end_date) VALUES (?,?,?,?,?,?)').run(a.program_id, a.player_id, a.assigned_by_staff_id || null, a.send_reminders ?? 1, a.start_date || (existing && existing.start_date) || null, a.end_date || (existing && existing.end_date) || null);
      },
      unassignProgram: async (programId, playerId) => sqliteDb.prepare('DELETE FROM program_assignments WHERE program_id = ? AND player_id = ?').run(programId, playerId),
      updateAssignmentStatus: async (programId, playerId, status) => sqliteDb.prepare('UPDATE program_assignments SET status = ? WHERE program_id = ? AND player_id = ?').run(status, programId, playerId),
      updateAssignmentDates: async (programId, playerId, startDate, endDate) => sqliteDb.prepare('UPDATE program_assignments SET start_date = ?, end_date = ? WHERE program_id = ? AND player_id = ?').run(startDate || null, endDate || null, programId, playerId),
      updateAllAssignmentDates: async (programId, startDate, endDate) => sqliteDb.prepare('UPDATE program_assignments SET start_date = ?, end_date = ? WHERE program_id = ?').run(startDate || null, endDate || null, programId),
      getSetting: async (key) => {
        const row = sqliteDb.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
        return row ? row.value : null;
      },
      setSetting: async (key, value) => sqliteDb.prepare('INSERT OR REPLACE INTO site_settings (key, value) VALUES (?, ?)').run(key, value),
      updateProgramPositions: async (id, positions) => sqliteDb.prepare('UPDATE programs SET assigned_positions = ? WHERE id = ?').run(positions, id),
      getConfirmedPlayers: async () => sqliteDb.prepare("SELECT * FROM players WHERE status = 'confirmed' ORDER BY player_name").all(),
      getAllProgramsWithPositions: async () => sqliteDb.prepare("SELECT * FROM programs WHERE assigned_positions IS NOT NULL AND assigned_positions != ''").all(),
      markDayComplete: async (programId, playerId, dayId, weekOf) => {
        const existing = sqliteDb.prepare('SELECT id FROM program_completions WHERE program_id = ? AND player_id = ? AND program_day_id = ? AND week_of = ?').get(programId, playerId, dayId, weekOf);
        if (existing) {
          sqliteDb.prepare('UPDATE program_completions SET completed_at = ? WHERE id = ?').run(new Date().toISOString(), existing.id);
        } else {
          sqliteDb.prepare('INSERT INTO program_completions (program_id, player_id, program_day_id, week_of) VALUES (?,?,?,?)').run(programId, playerId, dayId, weekOf);
        }
      },
      unmarkDayComplete: async (programId, playerId, dayId, weekOf) => sqliteDb.prepare('DELETE FROM program_completions WHERE program_id = ? AND player_id = ? AND program_day_id = ? AND week_of = ?').run(programId, playerId, dayId, weekOf),
      getCompletions: async (programId, playerId) => sqliteDb.prepare('SELECT * FROM program_completions WHERE program_id = ? AND player_id = ?').all(programId, playerId),
      getCompletionsForProgram: async (programId) => sqliteDb.prepare('SELECT * FROM program_completions WHERE program_id = ?').all(programId),
      getCompletionsForWeek: async (programId, weekOf) => sqliteDb.prepare('SELECT * FROM program_completions WHERE program_id = ? AND week_of = ?').all(programId, weekOf),
      getProgramEquipment: async (programId) => sqliteDb.prepare('SELECT * FROM program_equipment WHERE program_id = ? ORDER BY is_required DESC, sort_order').all(programId),
      addProgramEquipment: async (e) => ({ id: sqliteDb.prepare('INSERT INTO program_equipment (program_id, item_name, is_required, buy_url, sort_order) VALUES (?,?,?,?,?)').run(e.program_id, e.item_name, e.is_required, e.buy_url || null, e.sort_order || 0).lastInsertRowid }),
      updateProgramEquipment: async (id, e) => sqliteDb.prepare('UPDATE program_equipment SET item_name=?, is_required=?, buy_url=?, sort_order=? WHERE id=?').run(e.item_name, e.is_required, e.buy_url || null, e.sort_order || 0, id),
      removeProgramEquipment: async (id) => sqliteDb.prepare('DELETE FROM program_equipment WHERE id = ?').run(id),

      getAllQuizzes: async () => sqliteDb.prepare('SELECT * FROM quizzes ORDER BY position, title').all(),
      getQuiz: async (id) => sqliteDb.prepare('SELECT * FROM quizzes WHERE id = ?').get(id) || null,
      getQuizzesByPosition: async (pos) => sqliteDb.prepare('SELECT * FROM quizzes WHERE position = ?').all(pos),
      createQuiz: async (q) => ({ id: sqliteDb.prepare('INSERT INTO quizzes (title, position, description) VALUES (?,?,?)').run(q.title, q.position, q.description || null).lastInsertRowid }),
      getQuizQuestions: async (quizId) => sqliteDb.prepare('SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY sort_order').all(quizId),
      addQuizQuestion: async (q) => ({ id: sqliteDb.prepare('INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_answer, sort_order) VALUES (?,?,?,?,?,?,?,?)').run(q.quiz_id, q.question_text, q.option_a, q.option_b, q.option_c || null, q.option_d || null, q.correct_answer, q.sort_order || 0).lastInsertRowid }),
      assignQuiz: async (quizId, playerId) => { try { sqliteDb.prepare('INSERT INTO quiz_assignments (quiz_id, player_id) VALUES (?,?)').run(quizId, playerId); } catch(e) { /* duplicate */ } },
      getQuizAssignments: async (quizId) => sqliteDb.prepare('SELECT qa.*, p.player_name, p.parent_phone FROM quiz_assignments qa JOIN players p ON qa.player_id = p.id WHERE qa.quiz_id = ? ORDER BY p.player_name').all(quizId),
      getPlayerQuizAssignments: async (playerId) => sqliteDb.prepare('SELECT qa.*, q.title, q.position, q.description FROM quiz_assignments qa JOIN quizzes q ON qa.quiz_id = q.id WHERE qa.player_id = ? ORDER BY qa.assigned_at DESC').all(playerId),
      getQuizAttempts: async (quizId, playerId) => sqliteDb.prepare('SELECT * FROM quiz_attempts WHERE quiz_id = ? AND player_id = ? ORDER BY completed_at DESC').all(quizId, playerId),
      getAllQuizAttempts: async (quizId) => sqliteDb.prepare('SELECT qa.*, p.player_name FROM quiz_attempts qa JOIN players p ON qa.player_id = p.id WHERE qa.quiz_id = ? ORDER BY qa.completed_at DESC').all(quizId),
      addQuizAttempt: async (a) => ({ id: sqliteDb.prepare('INSERT INTO quiz_attempts (quiz_id, player_id, score, total, answers_json) VALUES (?,?,?,?,?)').run(a.quiz_id, a.player_id, a.score, a.total, a.answers_json || null).lastInsertRowid }),
      getQuizAttempt: async (id) => sqliteDb.prepare('SELECT qa.*, p.player_name, q.title as quiz_title, q.position as quiz_position FROM quiz_attempts qa JOIN players p ON qa.player_id = p.id JOIN quizzes q ON qa.quiz_id = q.id WHERE qa.id = ?').get(id) || null,
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
  getLineupGrid: (...args) => impl.getLineupGrid(...args),
  saveLineupGrid: (...args) => impl.saveLineupGrid(...args),
  getAdminByUsername: (...args) => impl.getAdminByUsername(...args),
  getAdminById: (...args) => impl.getAdminById(...args),
  getAllAdmins: (...args) => impl.getAllAdmins(...args),
  countAdmins: (...args) => impl.countAdmins(...args),
  createAdmin: (...args) => impl.createAdmin(...args),
  updateAdminPassword: (...args) => impl.updateAdminPassword(...args),
  updateAdminEmail: (...args) => impl.updateAdminEmail(...args),
  getAdminByEmail: (...args) => impl.getAdminByEmail(...args),
  removeAdmin: (...args) => impl.removeAdmin(...args),
  getRsvp: (...args) => impl.getRsvp(...args),
  getRsvpsForEvent: (...args) => impl.getRsvpsForEvent(...args),
  getRsvpCountsAll: (...args) => impl.getRsvpCountsAll(...args),
  clearGameScore: (...args) => impl.clearGameScore(...args),
  upsertRsvp: (...args) => impl.upsertRsvp(...args),
  hasReminderBeenSent: (...args) => impl.hasReminderBeenSent(...args),
  logReminder: (...args) => impl.logReminder(...args),
  updateJerseyNumber: (...args) => impl.updateJerseyNumber(...args),
  getParentAccountByPhone: (...args) => impl.getParentAccountByPhone(...args),
  getParentAccountByUsername: (...args) => impl.getParentAccountByUsername(...args),
  createParentAccount: (...args) => impl.createParentAccount(...args),
  getAllParentAccounts: (...args) => impl.getAllParentAccounts(...args),
  getParentAccountById: (...args) => impl.getParentAccountById(...args),
  updateParentAccountPassword: (...args) => impl.updateParentAccountPassword(...args),
  updateParentAccountName: (...args) => impl.updateParentAccountName(...args),
  updateParentAccountPhone: (...args) => impl.updateParentAccountPhone(...args),
  updateParentAccountUsername: (...args) => impl.updateParentAccountUsername(...args),
  updateParentLoginTime: (...args) => impl.updateParentLoginTime(...args),
  deleteParentAccount: (...args) => impl.deleteParentAccount(...args),
  updatePlayerParentPhone: (...args) => impl.updatePlayerParentPhone(...args),
  linkPlayerToAccount: (...args) => impl.linkPlayerToAccount(...args),
  unlinkPlayerFromAccount: (...args) => impl.unlinkPlayerFromAccount(...args),
  getLinkedPlayersByAccount: (...args) => impl.getLinkedPlayersByAccount(...args),
  getLinkedAccountsByPlayer: (...args) => impl.getLinkedAccountsByPlayer(...args),
  getAllPlayerParentLinks: (...args) => impl.getAllPlayerParentLinks(...args),
  updateAccountRole: (...args) => impl.updateAccountRole(...args),
  updateAccountApproved: (...args) => impl.updateAccountApproved(...args),
  getPendingFanAccounts: (...args) => impl.getPendingFanAccounts(...args),
  createParentAccountFull: (...args) => impl.createParentAccountFull(...args),
  updateGameScore: (...args) => impl.updateGameScore(...args),
  clearLineupGrid: (...args) => impl.clearLineupGrid(...args),
  clearPlayerFromLineupGrid: (...args) => impl.clearPlayerFromLineupGrid(...args),
  getAllMessages: (...args) => impl.getAllMessages(...args),
  getTopicReplies: (...args) => impl.getTopicReplies(...args),
  addMessage: (...args) => impl.addMessage(...args),
  removeMessage: (...args) => impl.removeMessage(...args),
  togglePinMessage: (...args) => impl.togglePinMessage(...args),
  getAllSavedLocations: (...args) => impl.getAllSavedLocations(...args),
  addSavedLocation: (...args) => impl.addSavedLocation(...args),
  removeSavedLocation: (...args) => impl.removeSavedLocation(...args),
  getAllScoreKeepers: (...args) => impl.getAllScoreKeepers(...args),
  addScoreKeeper: (...args) => impl.addScoreKeeper(...args),
  removeScoreKeeper: (...args) => impl.removeScoreKeeper(...args),
  getScoreKeeperByToken: (...args) => impl.getScoreKeeperByToken(...args),
  createLiveGame: (...args) => impl.createLiveGame(...args),
  getLiveGame: (...args) => impl.getLiveGame(...args),
  getLiveGameByEvent: (...args) => impl.getLiveGameByEvent(...args),
  updateGameState: (...args) => impl.updateGameState(...args),
  getAllActiveGames: (...args) => impl.getAllActiveGames(...args),
  setGameRoster: (...args) => impl.setGameRoster(...args),
  getGameRoster: (...args) => impl.getGameRoster(...args),
  updateRosterEntry: (...args) => impl.updateRosterEntry(...args),
  setOppRoster: (...args) => impl.setOppRoster(...args),
  getOppRoster: (...args) => impl.getOppRoster(...args),
  createAtBat: (...args) => impl.createAtBat(...args),
  updateAtBat: (...args) => impl.updateAtBat(...args),
  getAtBat: (...args) => impl.getAtBat(...args),
  getAtBatsForGame: (...args) => impl.getAtBatsForGame(...args),
  getAtBatsForPlayer: (...args) => impl.getAtBatsForPlayer(...args),
  deleteAtBat: (...args) => impl.deleteAtBat(...args),
  recordPitch: (...args) => impl.recordPitch(...args),
  getPitchesForAtBat: (...args) => impl.getPitchesForAtBat(...args),
  getPitchesForGame: (...args) => impl.getPitchesForGame(...args),
  getPitchCountForPitcher: (...args) => impl.getPitchCountForPitcher(...args),
  getLastPitchInAB: (...args) => impl.getLastPitchInAB(...args),
  deletePitch: (...args) => impl.deletePitch(...args),
  getPitchesForPitcherSeason: (...args) => impl.getPitchesForPitcherSeason(...args),
  addGameChat: (...args) => impl.addGameChat(...args),
  getGameChat: (...args) => impl.getGameChat(...args),
  pushUndo: (...args) => impl.pushUndo(...args),
  popUndo: (...args) => impl.popUndo(...args),
  getUndoCount: (...args) => impl.getUndoCount(...args),
  getAllPrograms: (...args) => impl.getAllPrograms(...args),
  getPublishedPrograms: (...args) => impl.getPublishedPrograms(...args),
  getProgram: (...args) => impl.getProgram(...args),
  addProgram: (...args) => impl.addProgram(...args),
  updateProgram: (...args) => impl.updateProgram(...args),
  removeProgram: (...args) => impl.removeProgram(...args),
  getProgramDays: (...args) => impl.getProgramDays(...args),
  addProgramDay: (...args) => impl.addProgramDay(...args),
  updateProgramDay: (...args) => impl.updateProgramDay(...args),
  removeProgramDay: (...args) => impl.removeProgramDay(...args),
  getProgramActivities: (...args) => impl.getProgramActivities(...args),
  addProgramActivity: (...args) => impl.addProgramActivity(...args),
  updateProgramActivity: (...args) => impl.updateProgramActivity(...args),
  removeProgramActivity: (...args) => impl.removeProgramActivity(...args),
  getProgramAssignments: (...args) => impl.getProgramAssignments(...args),
  getPlayerAssignments: (...args) => impl.getPlayerAssignments(...args),
  assignProgram: (...args) => impl.assignProgram(...args),
  unassignProgram: (...args) => impl.unassignProgram(...args),
  updateAssignmentStatus: (...args) => impl.updateAssignmentStatus(...args),
  updateAssignmentDates: (...args) => impl.updateAssignmentDates(...args),
  getSetting: (...args) => impl.getSetting(...args),
  setSetting: (...args) => impl.setSetting(...args),
  updateProgramPositions: (...args) => impl.updateProgramPositions(...args),
  updateAllAssignmentDates: (...args) => impl.updateAllAssignmentDates(...args),
  getConfirmedPlayers: (...args) => impl.getConfirmedPlayers(...args),
  getAllProgramsWithPositions: (...args) => impl.getAllProgramsWithPositions(...args),
  markDayComplete: (...args) => impl.markDayComplete(...args),
  unmarkDayComplete: (...args) => impl.unmarkDayComplete(...args),
  getCompletions: (...args) => impl.getCompletions(...args),
  getCompletionsForProgram: (...args) => impl.getCompletionsForProgram(...args),
  getCompletionsForWeek: (...args) => impl.getCompletionsForWeek(...args),
  hasProgramReminderBeenSent: (...args) => impl.hasProgramReminderBeenSent(...args),
  logProgramReminder: (...args) => impl.logProgramReminder(...args),
  getProgramEquipment: (...args) => impl.getProgramEquipment(...args),
  addProgramEquipment: (...args) => impl.addProgramEquipment(...args),
  updateProgramEquipment: (...args) => impl.updateProgramEquipment(...args),
  removeProgramEquipment: (...args) => impl.removeProgramEquipment(...args),
  getAllQuizzes: (...args) => impl.getAllQuizzes(...args),
  getQuiz: (...args) => impl.getQuiz(...args),
  getQuizzesByPosition: (...args) => impl.getQuizzesByPosition(...args),
  createQuiz: (...args) => impl.createQuiz(...args),
  getQuizQuestions: (...args) => impl.getQuizQuestions(...args),
  addQuizQuestion: (...args) => impl.addQuizQuestion(...args),
  assignQuiz: (...args) => impl.assignQuiz(...args),
  getQuizAssignments: (...args) => impl.getQuizAssignments(...args),
  getPlayerQuizAssignments: (...args) => impl.getPlayerQuizAssignments(...args),
  getQuizAttempts: (...args) => impl.getQuizAttempts(...args),
  getAllQuizAttempts: (...args) => impl.getAllQuizAttempts(...args),
  addQuizAttempt: (...args) => impl.addQuizAttempt(...args),
  getQuizAttempt: (...args) => impl.getQuizAttempt(...args),
};
