require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'allstars-2026-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production' && process.env.BASE_URL?.startsWith('https'),
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

app.set('trust proxy', 1);

function normalizePhone(phone) {
  return phone.replace(/\D/g, '').slice(-10);
}

const smtpTransport = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: (parseInt(process.env.SMTP_PORT) || 465) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;

let twilioClient = null;
const twilioFrom = process.env.TWILIO_FROM_NUMBER || null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log('Twilio SMS enabled');
  } catch (e) { console.log('Twilio not available:', e.message); }
}

const RSVP_SECRET = process.env.RSVP_SECRET || process.env.SESSION_SECRET || 'allstars-rsvp-2026';

function generateRsvpToken(eventId, playerId) {
  return crypto.createHmac('sha256', RSVP_SECRET).update(`${eventId}:${playerId}`).digest('hex').slice(0, 16);
}

function rsvpUrl(eventId, playerId) {
  const base = process.env.BASE_URL || 'http://localhost:3000';
  return `${base}/rsvp/${eventId}/${playerId}/${generateRsvpToken(eventId, playerId)}`;
}

async function sendSMS(to, body) {
  if (!twilioClient || !twilioFrom) return;
  const phone = '+1' + normalizePhone(to);
  try {
    await twilioClient.messages.create({ body, from: twilioFrom, to: phone });
    console.log(`SMS sent to ${phone}`);
  } catch (err) {
    console.error(`SMS failed to ${phone}:`, err.message);
  }
}

async function sendReminderEmail(to, player, event, link, reminderType) {
  if (!smtpTransport || !to) return;
  const when = reminderType === '48h' ? 'in 2 days' : 'tomorrow';
  const startDate = new Date(event.start_date + 'T12:00:00');
  const dateStr = startDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const timeStr = event.start_time ? (() => { const [h,m] = event.start_time.split(':'); const hr = parseInt(h); return (hr % 12 || 12) + ':' + m + ' ' + (hr >= 12 ? 'PM' : 'AM'); })() : '';
  try {
    await smtpTransport.sendMail({
      from: `"Cal Ripken All-Stars" <${process.env.SMTP_USER}>`,
      to,
      subject: `RSVP Needed: ${event.title} — ${dateStr}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#1a2744;color:#fff;padding:24px;text-align:center;">
            <h1 style="margin:0;font-size:22px;">⚾ Cal Ripken All-Stars</h1>
            <p style="margin:4px 0 0;color:#d4a843;">Summer 2026 &middot; Major Division</p>
          </div>
          <div style="padding:24px;background:#f9fafb;border:1px solid #e5e7eb;">
            <p>Hi — <strong>${player.player_name}</strong> hasn't RSVP'd for an upcoming event ${when}:</p>
            <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0;">
              <h2 style="margin:0 0 8px;color:#1a2744;font-size:18px;">${event.title}</h2>
              <p style="margin:4px 0;color:#374151;">${dateStr}${timeStr ? ' at ' + timeStr : ''}</p>
              ${event.location_name ? '<p style="margin:4px 0;color:#6b7280;">' + event.location_name + '</p>' : ''}
            </div>
            <p style="text-align:center;margin:24px 0;">
              <a href="${link}" style="background:#1a2744;color:#fff;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;">RSVP Now</a>
            </p>
            <p style="font-size:13px;color:#6b7280;text-align:center;">Click the button or paste this link: ${link}</p>
          </div>
        </div>`,
    });
    console.log(`Reminder email sent to ${to} for ${player.player_name} / ${event.title}`);
  } catch (err) {
    console.error(`Reminder email failed to ${to}:`, err.message);
  }
}

function getPlayerContacts(player) {
  const contacts = [];
  if (player.parent_email) contacts.push({ type: 'email', value: player.parent_email });
  if (player.parent_phone) contacts.push({ type: 'sms', value: player.parent_phone });
  try {
    const parsed = player.contacts ? JSON.parse(player.contacts) : [];
    for (const c of parsed) {
      if (c.email && !contacts.some(x => x.value === c.email)) contacts.push({ type: 'email', value: c.email });
      if (c.phone && !contacts.some(x => x.value === normalizePhone(c.phone))) contacts.push({ type: 'sms', value: normalizePhone(c.phone) });
    }
  } catch (e) {}
  return contacts;
}

async function checkAndSendReminders() {
  try {
    const now = new Date();
    const events = await db.getAllTeamEvents();
    const players = await db.getAllPlayers();
    const confirmed = players.filter(p => p.status === 'confirmed');

    for (const event of events) {
      const eventStart = new Date(event.start_date + 'T' + (event.start_time || '08:00') + ':00');
      const hoursUntil = (eventStart - now) / (1000 * 60 * 60);

      let reminderType = null;
      if (hoursUntil > 24 && hoursUntil <= 48) reminderType = '48h';
      else if (hoursUntil > 0 && hoursUntil <= 24) reminderType = '24h';
      if (!reminderType) continue;

      for (const player of confirmed) {
        const rsvp = await db.getRsvp(event.id, player.id);
        if (rsvp && rsvp.status !== 'pending') continue;

        const alreadySent = await db.hasReminderBeenSent(event.id, player.id, reminderType);
        if (alreadySent) continue;

        const link = rsvpUrl(event.id, player.id);
        const contacts = getPlayerContacts(player);

        for (const contact of contacts) {
          if (contact.type === 'email') {
            await sendReminderEmail(contact.value, player, event, link, reminderType);
          } else {
            const dateStr = new Date(event.start_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            await sendSMS(contact.value, `Cal Ripken All-Stars: ${player.player_name} hasn't RSVP'd for ${event.title} on ${dateStr}. Tap to respond: ${link}`);
          }
          await db.logReminder(event.id, player.id, reminderType, contact.type, contact.value);
        }
      }
    }
  } catch (err) {
    console.error('Reminder check error:', err.message);
  }
}

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

// --- Public Routes ---

app.get('/', async (req, res) => {
  const players = await db.getAllPlayers();
  const teamEvents = await db.getAllTeamEvents();
  res.render('index', { players, teamEvents });
});

app.get('/event/:id', async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/');
  const rsvps = await db.getRsvpsForEvent(event.id);
  const players = await db.getAllPlayers();
  const confirmed = players.filter(p => p.status === 'confirmed');
  const isAdmin = !!req.session.admin;
  let drills = [], subEvents = [], lineup = [], subLineups = {};
  if (event.event_type === 'practice') drills = await db.getDrills(event.id);
  if (event.event_type === 'tournament') {
    subEvents = await db.getSubEvents(event.id);
    for (const se of subEvents) {
      if (se.sub_type === 'game') subLineups[se.id] = await db.getLineupForSubEvent(se.id);
    }
  }
  if (event.event_type === 'game') lineup = await db.getLineupForEvent(event.id);
  res.render('event-detail', { event, rsvps, confirmedPlayers: confirmed, isAdmin, drills, subEvents, lineup, subLineups, POSITIONS: ['P','C','1B','2B','3B','SS','LF','CF','RF'] });
});

app.get('/rsvp/:eventId/:playerId/:token', async (req, res) => {
  const { eventId, playerId, token } = req.params;
  if (generateRsvpToken(Number(eventId), Number(playerId)) !== token) {
    return res.status(403).send('Invalid or expired RSVP link.');
  }
  const event = await db.getTeamEvent(Number(eventId));
  const player = await db.getPlayer(Number(playerId));
  if (!event || !player) return res.redirect('/');
  const rsvp = await db.getRsvp(event.id, player.id);
  res.render('rsvp', { event, player, rsvp, token, success: null });
});

app.post('/rsvp/:eventId/:playerId/:token', async (req, res) => {
  const { eventId, playerId, token } = req.params;
  if (generateRsvpToken(Number(eventId), Number(playerId)) !== token) {
    return res.status(403).send('Invalid or expired RSVP link.');
  }
  const event = await db.getTeamEvent(Number(eventId));
  const player = await db.getPlayer(Number(playerId));
  if (!event || !player) return res.redirect('/');
  const status = req.body.status;
  if (!['yes', 'no', 'maybe'].includes(status)) return res.redirect('/');
  await db.upsertRsvp(event.id, player.id, status);
  const rsvp = await db.getRsvp(event.id, player.id);
  res.render('rsvp', { event, player, rsvp, token, success: `${player.player_name} is marked as ${status === 'yes' ? 'attending' : status === 'no' ? 'not attending' : 'maybe'}.` });
});

app.post('/event/:id/rsvp', async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/');
  const phone = normalizePhone(req.body.phone || '');
  if (phone.length !== 10) return res.redirect('/event/' + event.id);
  const players = await db.getPlayersByPhone(phone);
  const confirmed = players.filter(p => p.status === 'confirmed');
  if (confirmed.length === 0) return res.redirect('/event/' + event.id);
  const status = req.body.status;
  if (!['yes', 'no', 'maybe'].includes(status)) return res.redirect('/event/' + event.id);
  for (const p of confirmed) {
    await db.upsertRsvp(event.id, p.id, status);
  }
  res.redirect('/event/' + event.id + '?rsvp=success');
});

app.get('/api/location-search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&addressdetails=1&countrycodes=us`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'CalRipkenAllStars/1.0 (matt@mt26.com)' }
    });
    const data = await resp.json();
    res.json(data.map(r => {
      const a = r.address || {};
      const name = a.leisure || a.amenity || a.building || a.tourism || r.name || r.display_name.split(',')[0];
      const parts = [];
      if (a.house_number && a.road) parts.push(a.house_number + ' ' + a.road);
      else if (a.road) parts.push(a.road);
      else if (a.house_number) parts.push(a.house_number);
      const city = a.city || a.town || a.village || a.hamlet || '';
      if (city) parts.push(city);
      if (a.state) parts.push(a.state);
      if (a.postcode) parts.push(a.postcode);
      const address = parts.length >= 2 ? parts.join(', ') : r.display_name;
      return { name, address, lat: r.lat, lon: r.lon };
    }));
  } catch (err) {
    console.error('Location search error:', err.message);
    res.json([]);
  }
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

// --- Profile Routes ---

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
  const isAdmin = !!req.session.admin;

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
  res.render('profile', { player, phone: isAdmin ? '' : phone, isAdmin, POSITIONS, RATING_FIELDS, events, error: null, success: null });
});

app.post('/profile/:id', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  const isAdmin = !!req.session.admin;

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
    player: updated, phone: isAdmin ? '' : phone, isAdmin, POSITIONS, RATING_FIELDS, events,
    error: null,
    success: `${player.player_name}'s profile has been saved.`
  });
});

app.post('/profile/:id/event', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  const isAdmin = !!req.session.admin;

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
      player, phone: isAdmin ? '' : phone, isAdmin, POSITIONS, RATING_FIELDS, events,
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
    player, phone: isAdmin ? '' : phone, isAdmin, POSITIONS, RATING_FIELDS, events,
    error: null,
    success: 'Availability event added.'
  });
});

app.post('/profile/:id/event/delete', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  const isAdmin = !!req.session.admin;

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
    player, phone: isAdmin ? '' : phone, isAdmin, POSITIONS, RATING_FIELDS, events,
    error: null,
    success: 'Event removed.'
  });
});

// --- Admin Auth ---

function requireAdmin(req, res, next) {
  if (req.session.admin) return next();
  res.redirect('/admin/login');
}

app.get('/admin/login', async (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  const count = await db.countAdmins();
  if (count === 0) return res.redirect('/admin/setup');
  res.render('admin-login', { error: null });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const admin = await db.getAdminByUsername((username || '').trim().toLowerCase());
  if (!admin || !bcrypt.compareSync(password || '', admin.password_hash)) {
    return res.render('admin-login', { error: 'Invalid username or password.' });
  }
  req.session.admin = { id: admin.id, username: admin.username };
  res.redirect('/admin');
});

app.get('/admin/setup', async (req, res) => {
  const count = await db.countAdmins();
  if (count > 0) return res.redirect('/admin/login');
  res.render('admin-setup', { error: null });
});

app.post('/admin/setup', async (req, res) => {
  const count = await db.countAdmins();
  if (count > 0) return res.redirect('/admin/login');

  const { username, password, confirm_password } = req.body;
  const user = (username || '').trim().toLowerCase();

  if (!user || user.length < 3) {
    return res.render('admin-setup', { error: 'Username must be at least 3 characters.' });
  }
  if (!password || password.length < 6) {
    return res.render('admin-setup', { error: 'Password must be at least 6 characters.' });
  }
  if (password !== confirm_password) {
    return res.render('admin-setup', { error: 'Passwords do not match.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  await db.createAdmin(user, hash);
  const admin = await db.getAdminByUsername(user);
  req.session.admin = { id: admin.id, username: admin.username };
  res.redirect('/admin');
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// --- Admin Dashboard ---

app.get('/admin', requireAdmin, async (req, res) => {
  const players = await db.getAllPlayers();
  const staff = await db.getAllStaff();
  const confirmed = players.filter(p => p.status === 'confirmed').length;
  const declined = players.filter(p => p.status === 'declined').length;
  const pending = players.filter(p => p.status === 'pending').length;
  const allEvents = await db.getAllEvents();
  const teamEvents = await db.getAllTeamEvents();
  res.render('admin', {
    players, staff, confirmed, declined, pending, total: players.length, allEvents, teamEvents,
    adminUser: req.session.admin,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

app.post('/admin/status', requireAdmin, async (req, res) => {
  const { player_id, status } = req.body;
  if (!['confirmed', 'declined', 'pending'].includes(status)) {
    return res.redirect('/admin?error=Invalid+status');
  }
  await db.updateStatus(Number(player_id), status);
  const player = await db.getPlayer(Number(player_id));
  res.redirect('/admin?success=' + encodeURIComponent(`${player.player_name} set to ${status}`));
});

app.post('/admin/add-player', requireAdmin, async (req, res) => {
  const { player_name, division, team, age, parent_name, parent_phone, parent_email } = req.body;
  const phone = normalizePhone(parent_phone || '');

  if (!player_name || !player_name.trim() || !parent_name || !parent_name.trim() || phone.length !== 10) {
    return res.redirect('/admin?error=' + encodeURIComponent('Player name, parent name, and valid 10-digit phone are required.'));
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

  res.redirect('/admin?success=' + encodeURIComponent(`${player_name.trim()} added to roster` + (parent_email ? ' — confirmation email sent' : '')));
});

app.post('/admin/remove-player', requireAdmin, async (req, res) => {
  const player = await db.getPlayer(Number(req.body.player_id));
  if (player) {
    await db.removePlayer(Number(req.body.player_id));
    res.redirect('/admin?success=' + encodeURIComponent(`${player.player_name} removed from roster`));
  } else {
    res.redirect('/admin?error=Player+not+found');
  }
});

app.post('/admin/send-email', requireAdmin, async (req, res) => {
  const player = await db.getPlayer(Number(req.body.player_id));
  if (!player) return res.redirect('/admin?error=Player+not+found');

  const email = player.parent_email || (() => {
    try { const c = JSON.parse(player.contacts || '[]'); return c.find(x => x.email)?.email; } catch { return null; }
  })();

  if (!email) {
    return res.redirect('/admin?error=' + encodeURIComponent(`No email on file for ${player.player_name}`));
  }

  await sendConfirmationEmail(player, email);
  res.redirect('/admin?success=' + encodeURIComponent(`Confirmation email sent to ${email} for ${player.player_name}`));
});

app.post('/admin/add-staff', requireAdmin, async (req, res) => {
  const { name, role, phone, email } = req.body;
  const normalized = normalizePhone(phone || '');
  if (!name || !name.trim() || normalized.length !== 10) {
    return res.redirect('/admin?error=' + encodeURIComponent('Staff name and valid phone required.'));
  }
  await db.addStaff({ name: name.trim(), role: (role || 'Coach').trim(), phone: normalized, email: (email || '').trim() || null });
  res.redirect('/admin?success=' + encodeURIComponent(`${name.trim()} added as staff`));
});

app.post('/admin/edit-staff', requireAdmin, async (req, res) => {
  const { staff_id, name, role, phone, email } = req.body;
  const normalized = normalizePhone(phone || '');
  if (!name || !name.trim() || normalized.length !== 10) {
    return res.redirect('/admin?error=' + encodeURIComponent('Staff name and valid phone required.'));
  }
  await db.updateStaff(Number(staff_id), { name: name.trim(), role: (role || 'Coach').trim(), phone: normalized, email: (email || '').trim() || null });
  res.redirect('/admin?success=' + encodeURIComponent(`${name.trim()} updated`));
});

app.post('/admin/remove-staff', requireAdmin, async (req, res) => {
  await db.removeStaff(Number(req.body.staff_id));
  res.redirect('/admin?success=Staff+member+removed');
});

// --- Team Events (admin + staff) ---

function requireAdminOrStaff(req, res, next) {
  if (req.session.admin) return next();
  if (req.body.staff_phone) {
    return db.getStaffByPhone(normalizePhone(req.body.staff_phone)).then(staff => {
      if (staff) { req.staffUser = staff; return next(); }
      res.redirect('/staff');
    });
  }
  res.redirect('/admin/login');
}

app.post('/admin/add-team-event', requireAdminOrStaff, async (req, res) => {
  const { event_type, title, start_date, start_time, end_date, end_time, location_name, address, notes, hotel_info, carpool_info } = req.body;
  const dates = req.body.dates;
  const multiDates = dates ? (Array.isArray(dates) ? dates : [dates]).filter(Boolean).sort() : [];

  if (!title || !title.trim() || (!start_date && multiDates.length === 0)) {
    const dest = req.session.admin ? '/admin' : '/staff/dashboard?phone=' + req.body.staff_phone;
    return res.redirect(dest + (dest.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent('Event title and at least one date are required.'));
  }

  const eventData = {
    event_type: event_type || 'practice',
    title: title.trim(),
    start_time: start_time || null,
    end_time: end_time || null,
    location_name: (location_name || '').trim() || null,
    address: (address || '').trim() || null,
    notes: (notes || '').trim() || null,
    hotel_info: (hotel_info || '').trim() || null,
    carpool_info: (carpool_info || '').trim() || null,
  };

  if (multiDates.length > 0) {
    for (const d of multiDates) {
      await db.addTeamEvent({ ...eventData, start_date: d, end_date: null });
    }
    const dest = req.session.admin ? '/admin' : '/staff/dashboard?phone=' + req.body.staff_phone;
    res.redirect(dest + (dest.includes('?') ? '&' : '?') + 'success=' + encodeURIComponent(`"${title.trim()}" added for ${multiDates.length} dates`));
  } else {
    await db.addTeamEvent({ ...eventData, start_date, end_date: end_date || null });
    const dest = req.session.admin ? '/admin' : '/staff/dashboard?phone=' + req.body.staff_phone;
    res.redirect(dest + (dest.includes('?') ? '&' : '?') + 'success=' + encodeURIComponent(`"${title.trim()}" added to calendar`));
  }
});

app.post('/admin/edit-team-event', requireAdminOrStaff, async (req, res) => {
  const { event_id, event_type, title, start_date, start_time, end_date, end_time, location_name, address, notes, hotel_info, carpool_info } = req.body;
  if (!title || !title.trim() || !start_date) {
    const dest = req.session.admin ? '/admin' : '/staff/dashboard?phone=' + req.body.staff_phone;
    return res.redirect(dest + (dest.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent('Event title and start date are required.'));
  }
  await db.updateTeamEvent(Number(event_id), {
    event_type: event_type || 'practice',
    title: title.trim(),
    start_date,
    start_time: start_time || null,
    end_date: end_date || null,
    end_time: end_time || null,
    location_name: (location_name || '').trim() || null,
    address: (address || '').trim() || null,
    notes: (notes || '').trim() || null,
    hotel_info: (hotel_info || '').trim() || null,
    carpool_info: (carpool_info || '').trim() || null,
  });
  const dest = req.session.admin ? '/admin' : '/staff/dashboard?phone=' + req.body.staff_phone;
  res.redirect(dest + (dest.includes('?') ? '&' : '?') + 'success=' + encodeURIComponent(`"${title.trim()}" updated`));
});

app.post('/admin/remove-team-event', requireAdmin, async (req, res) => {
  await db.removeTeamEvent(Number(req.body.event_id));
  res.redirect('/admin?success=Event+removed');
});

// --- Practice Drills ---
app.post('/event/:id/drill', requireAdmin, async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/admin');
  const drills = await db.getDrills(event.id);
  await db.addDrill({
    team_event_id: event.id,
    drill_name: (req.body.drill_name || '').trim() || 'New Drill',
    description: (req.body.description || '').trim() || null,
    duration_minutes: parseInt(req.body.duration_minutes) || 10,
    sort_order: drills.length,
  });
  res.redirect('/event/' + event.id);
});

app.post('/event/:id/drill/:drillId/update', requireAdmin, async (req, res) => {
  await db.updateDrill(Number(req.params.drillId), {
    drill_name: (req.body.drill_name || '').trim() || 'Drill',
    description: (req.body.description || '').trim() || null,
    duration_minutes: parseInt(req.body.duration_minutes) || 10,
    sort_order: parseInt(req.body.sort_order) || 0,
  });
  res.redirect('/event/' + req.params.id);
});

app.post('/event/:id/drill/:drillId/delete', requireAdmin, async (req, res) => {
  await db.removeDrill(Number(req.params.drillId));
  res.redirect('/event/' + req.params.id);
});

// --- Tournament Sub-Events ---
app.post('/event/:id/sub-event', requireAdmin, async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/admin');
  await db.addSubEvent({
    team_event_id: event.id,
    sub_type: req.body.sub_type || 'game',
    title: (req.body.title || '').trim() || 'Game',
    start_date: req.body.start_date || event.start_date,
    start_time: req.body.start_time || null,
    end_time: req.body.end_time || null,
    location_name: (req.body.location_name || '').trim() || null,
    opponent: (req.body.opponent || '').trim() || null,
    notes: (req.body.notes || '').trim() || null,
    batting_all: req.body.batting_all ? 1 : 0,
  });
  res.redirect('/event/' + event.id);
});

app.post('/event/:id/sub-event/:subId/update', requireAdmin, async (req, res) => {
  await db.updateSubEvent(Number(req.params.subId), {
    sub_type: req.body.sub_type || 'game',
    title: (req.body.title || '').trim() || 'Game',
    start_date: req.body.start_date || null,
    start_time: req.body.start_time || null,
    end_time: req.body.end_time || null,
    location_name: (req.body.location_name || '').trim() || null,
    opponent: (req.body.opponent || '').trim() || null,
    notes: (req.body.notes || '').trim() || null,
    batting_all: req.body.batting_all ? 1 : 0,
  });
  res.redirect('/event/' + req.params.id);
});

app.post('/event/:id/sub-event/:subId/delete', requireAdmin, async (req, res) => {
  await db.removeSubEvent(Number(req.params.subId));
  res.redirect('/event/' + req.params.id);
});

// --- Game Lineups ---
app.post('/event/:id/lineup', requireAdmin, async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/admin');
  if (req.body.batting_all !== undefined) {
    await db.updateBattingAll(event.id, req.body.batting_all === '1');
  }
  const playerIds = Array.isArray(req.body.player_id) ? req.body.player_id : [req.body.player_id].filter(Boolean);
  const positions = Array.isArray(req.body.position) ? req.body.position : [req.body.position].filter(Boolean);
  const orders = Array.isArray(req.body.batting_order) ? req.body.batting_order : [req.body.batting_order].filter(Boolean);
  const starters = Array.isArray(req.body.is_starter) ? req.body.is_starter : [req.body.is_starter].filter(Boolean);
  const starterSet = new Set(starters);
  const entries = playerIds.map((pid, i) => ({
    team_event_id: event.id,
    sub_event_id: null,
    player_id: Number(pid),
    position: (positions[i] || '').trim() || null,
    batting_order: parseInt(orders[i]) || (i + 1),
    is_starter: starterSet.has(pid) ? 1 : 0,
  }));
  if (entries.length > 0) await db.saveLineup(entries);
  res.redirect('/event/' + event.id);
});

app.post('/event/:id/sub-event/:subId/lineup', requireAdmin, async (req, res) => {
  const subId = Number(req.params.subId);
  if (req.body.batting_all !== undefined) {
    const sub = await db.getSubEvent(subId);
    if (sub) await db.updateSubEvent(subId, { ...sub, batting_all: req.body.batting_all === '1' ? 1 : 0 });
  }
  const playerIds = Array.isArray(req.body.player_id) ? req.body.player_id : [req.body.player_id].filter(Boolean);
  const positions = Array.isArray(req.body.position) ? req.body.position : [req.body.position].filter(Boolean);
  const orders = Array.isArray(req.body.batting_order) ? req.body.batting_order : [req.body.batting_order].filter(Boolean);
  const starters = Array.isArray(req.body.is_starter) ? req.body.is_starter : [req.body.is_starter].filter(Boolean);
  const starterSet = new Set(starters);
  const entries = playerIds.map((pid, i) => ({
    team_event_id: null,
    sub_event_id: subId,
    player_id: Number(pid),
    position: (positions[i] || '').trim() || null,
    batting_order: parseInt(orders[i]) || (i + 1),
    is_starter: starterSet.has(pid) ? 1 : 0,
  }));
  if (entries.length > 0) await db.saveLineup(entries);
  res.redirect('/event/' + req.params.id);
});

app.get('/admin/event/:id/rsvps', requireAdmin, async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/admin');
  const rsvps = await db.getRsvpsForEvent(event.id);
  const players = await db.getAllPlayers();
  const confirmed = players.filter(p => p.status === 'confirmed');
  res.json({
    event: { id: event.id, title: event.title, start_date: event.start_date },
    rsvps,
    confirmed: confirmed.map(p => ({
      id: p.id, player_name: p.player_name,
      rsvp: rsvps.find(r => r.player_id === p.id) || null,
    })),
  });
});

// --- Admin Settings ---

app.get('/admin/settings', requireAdmin, async (req, res) => {
  const admins = await db.getAllAdmins();
  res.render('admin-settings', {
    adminUser: req.session.admin,
    admins,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

app.post('/admin/change-password', requireAdmin, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const admin = await db.getAdminById(req.session.admin.id);

  if (!bcrypt.compareSync(current_password || '', admin.password_hash)) {
    return res.redirect('/admin/settings?error=' + encodeURIComponent('Current password is incorrect.'));
  }
  if (!new_password || new_password.length < 6) {
    return res.redirect('/admin/settings?error=' + encodeURIComponent('New password must be at least 6 characters.'));
  }
  if (new_password !== confirm_password) {
    return res.redirect('/admin/settings?error=' + encodeURIComponent('New passwords do not match.'));
  }

  const hash = bcrypt.hashSync(new_password, 10);
  await db.updateAdminPassword(admin.id, hash);
  res.redirect('/admin/settings?success=' + encodeURIComponent('Password updated.'));
});

app.post('/admin/add-admin', requireAdmin, async (req, res) => {
  const { username, password, confirm_password } = req.body;
  const user = (username || '').trim().toLowerCase();

  if (!user || user.length < 3) {
    return res.redirect('/admin/settings?error=' + encodeURIComponent('Username must be at least 3 characters.'));
  }
  if (!password || password.length < 6) {
    return res.redirect('/admin/settings?error=' + encodeURIComponent('Password must be at least 6 characters.'));
  }
  if (password !== confirm_password) {
    return res.redirect('/admin/settings?error=' + encodeURIComponent('Passwords do not match.'));
  }

  const existing = await db.getAdminByUsername(user);
  if (existing) {
    return res.redirect('/admin/settings?error=' + encodeURIComponent('Username already exists.'));
  }

  const hash = bcrypt.hashSync(password, 10);
  await db.createAdmin(user, hash);
  res.redirect('/admin/settings?success=' + encodeURIComponent(`Admin "${user}" created.`));
});

app.post('/admin/remove-admin', requireAdmin, async (req, res) => {
  const targetId = Number(req.body.admin_id);
  if (targetId === req.session.admin.id) {
    return res.redirect('/admin/settings?error=' + encodeURIComponent('You cannot remove yourself.'));
  }
  await db.removeAdmin(targetId);
  res.redirect('/admin/settings?success=Admin+removed.');
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
  const teamEvents = await db.getAllTeamEvents();
  res.render('staff-dashboard', { staff, players, confirmed, declined, pending, total: players.length, phone, RATING_FIELDS, allEvents, teamEvents, success: req.query.success || null, error: req.query.error || null });
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
  setInterval(checkAndSendReminders, 15 * 60 * 1000);
  setTimeout(checkAndSendReminders, 15000);
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
