require('dotenv').config();
const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function normalizePhone(phone) {
  return phone.replace(/\D/g, '').slice(-10);
}

const smtpTransport = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: (parseInt(process.env.SMTP_PORT) || 465) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;

async function sendConfirmationEmail(player, email) {
  if (!smtpTransport || !email) return;
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  try {
    await smtpTransport.sendMail({
      from: `"Cal Ripken All-Stars" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `${player.player_name} — All-Star Team Selection`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#1a2744;color:#fff;padding:24px;text-align:center;">
            <h1 style="margin:0;font-size:22px;">⚾ Cal Ripken All-Stars</h1>
            <p style="margin:4px 0 0;color:#d4a843;">Summer 2026 &middot; Major Division</p>
          </div>
          <div style="padding:24px;background:#f9fafb;border:1px solid #e5e7eb;">
            <p>Hi ${player.parent_name},</p>
            <p><strong>${player.player_name}</strong> has been selected for the <strong>Summer 2026 Cal Ripken All-Star</strong> team!</p>
            <p>Please confirm or decline participation using the link below:</p>
            <p style="text-align:center;margin:24px 0;">
              <a href="${baseUrl}/verify" style="background:#1a2744;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:bold;">Confirm Your Player</a>
            </p>
            <p style="font-size:14px;color:#6b7280;">Use your registered phone number <strong>${player.parent_phone.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3')}</strong> to look up your player and respond.</p>
            <p style="font-size:14px;color:#6b7280;">You can also fill out a player profile with positions, skills, and contact info for GameChanger.</p>
            <p>Thank you!<br>Cal Ripken All-Stars Coaching Staff</p>
          </div>
        </div>`,
    });
    console.log(`Confirmation email sent to ${email} for ${player.player_name}`);
  } catch (err) {
    console.error(`Failed to send email to ${email}:`, err.message);
  }
}

app.get('/', async (req, res) => {
  const players = await db.getAllPlayers();
  res.render('index', { players });
});

app.get('/verify', (req, res) => {
  res.render('verify', { players: null, phone: '', error: null, success: null });
});

app.post('/verify', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  if (phone.length !== 10) {
    return res.render('verify', {
      players: null, phone: req.body.phone || '', error: 'Please enter a valid 10-digit phone number.', success: null
    });
  }

  const players = await db.getPlayersByPhone(phone);
  if (players.length === 0) {
    return res.render('verify', {
      players: null, phone: req.body.phone || '',
      error: 'No players found for that phone number. Please use the number your league has on file.',
      success: null
    });
  }

  res.render('verify', { players, phone, error: null, success: null });
});

app.post('/respond', async (req, res) => {
  const { player_id, phone, status } = req.body;
  const normalized = normalizePhone(phone || '');

  if (!['confirmed', 'declined'].includes(status)) {
    return res.redirect('/verify');
  }

  const player = await db.getPlayer(Number(player_id));
  if (!player || player.parent_phone !== normalized) {
    return res.render('verify', {
      players: null, phone: '',
      error: 'Unauthorized. You can only update your own child\'s status.',
      success: null
    });
  }

  await db.updateStatus(Number(player_id), status);

  const players = await db.getPlayersByPhone(normalized);
  const action = status === 'confirmed' ? 'confirmed' : 'declined';
  res.render('verify', {
    players, phone: normalized,
    error: null,
    success: `${player.player_name} has been ${action} for the All-Star team. You can change this anytime.`
  });
});

const POSITIONS = ['P','C','1B','2B','3B','SS','LF','CF','RF'];
const RATING_FIELDS = [
  { key: 'arm_strength',      label: 'Arm Strength' },
  { key: 'throwing_accuracy',  label: 'Throwing Accuracy' },
  { key: 'contact_hitting',    label: 'Contact Hitting' },
  { key: 'power_hitting',      label: 'Power' },
  { key: 'pitching',           label: 'Pitching' },
  { key: 'infield_defense',    label: 'Infield Defense' },
  { key: 'outfield_defense',   label: 'Outfield Defense' },
  { key: 'catcher_skill',      label: 'Catcher' },
  { key: 'baseball_iq',        label: 'Baseball IQ' },
];

app.get('/profile/:id', async (req, res) => {
  const phone = normalizePhone(req.query.phone || '');
  const adminKey = req.query.key || '';
  const isAdmin = adminKey === ADMIN_PASS;

  if (!isAdmin && phone.length !== 10) return res.redirect('/verify');

  const player = await db.getPlayer(Number(req.params.id));
  if (!player || (!isAdmin && player.parent_phone !== phone)) {
    return res.render('verify', {
      players: null, phone: '',
      error: 'Unauthorized. You can only edit your own child\'s profile.',
      success: null
    });
  }

  const events = await db.getPlayerEvents(player.id);
  res.render('profile', { player, phone: isAdmin ? '' : phone, adminKey: isAdmin ? adminKey : '', POSITIONS, RATING_FIELDS, events, error: null, success: null });
});

app.post('/profile/:id', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  const adminKey = req.body.adminKey || '';
  const isAdmin = adminKey === ADMIN_PASS;

  const player = await db.getPlayer(Number(req.params.id));
  if (!player || (!isAdmin && player.parent_phone !== phone)) {
    return res.render('verify', {
      players: null, phone: '',
      error: 'Unauthorized. You can only edit your own child\'s profile.',
      success: null
    });
  }

  const toInt = (v) => { const n = parseInt(v); return (n >= 1 && n <= 5) ? n : null; };
  const toList = (v) => Array.isArray(v) ? v.filter(p => POSITIONS.includes(p)).join(',') : '';

  const contacts = [];
  const cNames = Array.isArray(req.body.contact_name) ? req.body.contact_name : [req.body.contact_name].filter(Boolean);
  const cEmails = Array.isArray(req.body.contact_email) ? req.body.contact_email : [req.body.contact_email].filter(Boolean);
  const cPhones = Array.isArray(req.body.contact_phone) ? req.body.contact_phone : [req.body.contact_phone].filter(Boolean);
  const cRelations = Array.isArray(req.body.contact_relation) ? req.body.contact_relation : [req.body.contact_relation].filter(Boolean);
  for (let i = 0; i < cNames.length; i++) {
    if (cNames[i] && cNames[i].trim()) {
      contacts.push({
        name: cNames[i].trim(),
        email: (cEmails[i] || '').trim(),
        phone: normalizePhone(cPhones[i] || ''),
        relation: (cRelations[i] || '').trim(),
      });
    }
  }

  await db.updateProfile(Number(req.params.id), {
    birthdate: req.body.birthdate || null,
    best_positions: toList(req.body.best_positions),
    favorite_positions: toList(req.body.favorite_positions),
    arm_strength: toInt(req.body.arm_strength),
    throwing_accuracy: toInt(req.body.throwing_accuracy),
    contact_hitting: toInt(req.body.contact_hitting),
    power_hitting: toInt(req.body.power_hitting),
    pitching: toInt(req.body.pitching),
    infield_defense: toInt(req.body.infield_defense),
    outfield_defense: toInt(req.body.outfield_defense),
    catcher_skill: toInt(req.body.catcher_skill),
    baseball_iq: toInt(req.body.baseball_iq),
    contacts: JSON.stringify(contacts),
  });

  const updated = await db.getPlayer(Number(req.params.id));
  const events = await db.getPlayerEvents(updated.id);
  res.render('profile', {
    player: updated, phone: isAdmin ? '' : phone, adminKey: isAdmin ? adminKey : '', POSITIONS, RATING_FIELDS, events,
    error: null,
    success: `${player.player_name}'s profile has been saved.`
  });
});

app.post('/profile/:id/event', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  const adminKey = req.body.adminKey || '';
  const isAdmin = adminKey === ADMIN_PASS;

  const player = await db.getPlayer(Number(req.params.id));
  if (!player || (!isAdmin && player.parent_phone !== phone)) {
    return res.render('verify', {
      players: null, phone: '',
      error: 'Unauthorized.',
      success: null
    });
  }

  const { event_type, start_date, end_date, notes } = req.body;
  if (!start_date) {
    const events = await db.getPlayerEvents(player.id);
    return res.render('profile', {
      player, phone: isAdmin ? '' : phone, adminKey: isAdmin ? adminKey : '', POSITIONS, RATING_FIELDS, events,
      error: 'Start date is required.',
      success: null
    });
  }

  await db.addEvent({
    player_id: player.id,
    event_type: event_type || 'unavailable',
    start_date,
    end_date: end_date || null,
    notes: (notes || '').trim() || null,
  });

  const events = await db.getPlayerEvents(player.id);
  res.render('profile', {
    player, phone: isAdmin ? '' : phone, adminKey: isAdmin ? adminKey : '', POSITIONS, RATING_FIELDS, events,
    error: null,
    success: 'Availability event added.'
  });
});

app.post('/profile/:id/event/delete', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  const adminKey = req.body.adminKey || '';
  const isAdmin = adminKey === ADMIN_PASS;

  const player = await db.getPlayer(Number(req.params.id));
  if (!player || (!isAdmin && player.parent_phone !== phone)) {
    return res.render('verify', {
      players: null, phone: '',
      error: 'Unauthorized.',
      success: null
    });
  }

  await db.removeEvent(Number(req.body.event_id));
  const events = await db.getPlayerEvents(player.id);
  res.render('profile', {
    player, phone: isAdmin ? '' : phone, adminKey: isAdmin ? adminKey : '', POSITIONS, RATING_FIELDS, events,
    error: null,
    success: 'Event removed.'
  });
});

// --- Admin ---
const ADMIN_PASS = process.env.ADMIN_PASS || 'allstars2026';

function requireAdmin(req, res, next) {
  if (req.query.key === ADMIN_PASS || req.body.key === ADMIN_PASS) return next();
  res.render('admin-login', { error: req.query.failed ? 'Incorrect password.' : null });
}

app.get('/admin', requireAdmin, async (req, res) => {
  const players = await db.getAllPlayers();
  const staff = await db.getAllStaff();
  const confirmed = players.filter(p => p.status === 'confirmed').length;
  const declined = players.filter(p => p.status === 'declined').length;
  const pending = players.filter(p => p.status === 'pending').length;
  const allEvents = await db.getAllEvents();
  res.render('admin', { players, staff, confirmed, declined, pending, total: players.length, key: ADMIN_PASS, allEvents, success: req.query.success || null, error: req.query.error || null });
});

app.get('/admin/login', (req, res) => {
  res.render('admin-login', { error: null });
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASS) {
    return res.redirect('/admin?key=' + ADMIN_PASS);
  }
  res.render('admin-login', { error: 'Incorrect password.' });
});

app.post('/admin/status', requireAdmin, async (req, res) => {
  const { player_id, status } = req.body;
  if (!['confirmed', 'declined', 'pending'].includes(status)) {
    return res.redirect('/admin?key=' + ADMIN_PASS + '&error=Invalid+status');
  }
  await db.updateStatus(Number(player_id), status);
  const player = await db.getPlayer(Number(player_id));
  res.redirect('/admin?key=' + ADMIN_PASS + '&success=' + encodeURIComponent(`${player.player_name} set to ${status}`));
});

app.post('/admin/add-player', requireAdmin, async (req, res) => {
  const { player_name, division, team, age, parent_name, parent_phone, parent_email } = req.body;
  const phone = normalizePhone(parent_phone || '');

  if (!player_name || !player_name.trim() || !parent_name || !parent_name.trim() || phone.length !== 10) {
    return res.redirect('/admin?key=' + ADMIN_PASS + '&error=' + encodeURIComponent('Player name, parent name, and valid 10-digit phone are required.'));
  }

  await db.addPlayer({
    player_name: player_name.trim(),
    division: (division || 'Major').trim(),
    team: (team || '').trim(),
    age: parseInt(age) || 11,
    parent_name: parent_name.trim(),
    parent_phone: phone,
    parent_email: (parent_email || '').trim() || null,
  });

  const players = await db.getAllPlayers();
  const newPlayer = players.find(p => p.parent_phone === phone && p.player_name === player_name.trim());
  if (newPlayer && newPlayer.parent_email) {
    sendConfirmationEmail(newPlayer, newPlayer.parent_email);
  }

  res.redirect('/admin?key=' + ADMIN_PASS + '&success=' + encodeURIComponent(`${player_name.trim()} added to roster` + (parent_email ? ' — confirmation email sent' : '')));
});

app.post('/admin/remove-player', requireAdmin, async (req, res) => {
  const player = await db.getPlayer(Number(req.body.player_id));
  if (player) {
    await db.removePlayer(Number(req.body.player_id));
    res.redirect('/admin?key=' + ADMIN_PASS + '&success=' + encodeURIComponent(`${player.player_name} removed from roster`));
  } else {
    res.redirect('/admin?key=' + ADMIN_PASS + '&error=Player+not+found');
  }
});

app.post('/admin/send-email', requireAdmin, async (req, res) => {
  const player = await db.getPlayer(Number(req.body.player_id));
  if (!player) return res.redirect('/admin?key=' + ADMIN_PASS + '&error=Player+not+found');

  const email = player.parent_email || (() => {
    try { const c = JSON.parse(player.contacts || '[]'); return c.find(x => x.email)?.email; } catch { return null; }
  })();

  if (!email) {
    return res.redirect('/admin?key=' + ADMIN_PASS + '&error=' + encodeURIComponent(`No email on file for ${player.player_name}`));
  }

  await sendConfirmationEmail(player, email);
  res.redirect('/admin?key=' + ADMIN_PASS + '&success=' + encodeURIComponent(`Confirmation email sent to ${email} for ${player.player_name}`));
});

app.post('/admin/add-staff', requireAdmin, async (req, res) => {
  const { name, role, phone } = req.body;
  const normalized = normalizePhone(phone || '');
  if (!name || !name.trim() || normalized.length !== 10) {
    return res.redirect('/admin?key=' + ADMIN_PASS + '&error=' + encodeURIComponent('Staff name and valid phone required.'));
  }
  await db.addStaff({ name: name.trim(), role: (role || 'Coach').trim(), phone: normalized });
  res.redirect('/admin?key=' + ADMIN_PASS + '&success=' + encodeURIComponent(`${name.trim()} added as staff`));
});

app.post('/admin/remove-staff', requireAdmin, async (req, res) => {
  await db.removeStaff(Number(req.body.staff_id));
  res.redirect('/admin?key=' + ADMIN_PASS + '&success=Staff+member+removed');
});

// --- Staff View (read-only) ---
app.get('/staff', (req, res) => {
  res.render('staff-login', { error: null });
});

app.post('/staff', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  const staff = await db.getStaffByPhone(phone);
  if (!staff) {
    return res.render('staff-login', { error: 'Phone number not recognized as staff.' });
  }
  res.redirect('/staff/dashboard?phone=' + phone);
});

app.get('/staff/dashboard', async (req, res) => {
  const phone = normalizePhone(req.query.phone || '');
  const staff = await db.getStaffByPhone(phone);
  if (!staff) return res.redirect('/staff');

  const players = await db.getAllPlayers();
  const confirmed = players.filter(p => p.status === 'confirmed').length;
  const declined = players.filter(p => p.status === 'declined').length;
  const pending = players.filter(p => p.status === 'pending').length;
  const allEvents = await db.getAllEvents();
  res.render('staff-dashboard', { staff, players, confirmed, declined, pending, total: players.length, phone, RATING_FIELDS, allEvents });
});

app.get('/api/stats', async (req, res) => {
  const players = await db.getAllPlayers();
  const confirmed = players.filter(p => p.status === 'confirmed').length;
  const declined = players.filter(p => p.status === 'declined').length;
  const pending = players.filter(p => p.status === 'pending').length;
  res.json({ total: players.length, confirmed, declined, pending, players });
});

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`All-Stars portal running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
