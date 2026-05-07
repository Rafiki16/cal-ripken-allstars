require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'allstars-2026-secret',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
};

if (process.env.DATABASE_URL) {
  const pgSession = require('connect-pg-simple')(session);
  const { Pool } = require('pg');
  sessionConfig.store = new pgSession({
    pool: new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }),
    tableName: 'user_sessions',
    createTableIfMissing: true,
  });
}

app.use(session(sessionConfig));

function normalizePhone(phone) {
  return phone.replace(/\D/g, '').slice(-10);
}

const smtpPort = parseInt(process.env.SMTP_PORT) || 587;
const smtpTransport = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpPort === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
}) : null;
if (smtpTransport) {
  smtpTransport.verify().then(() => console.log('SMTP connection verified')).catch(e => console.error('SMTP verify failed:', e.message));
}

let twilioClient = null;
const twilioFrom = process.env.TWILIO_FROM_NUMBER || null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log('Twilio SMS enabled');
  } catch (e) { console.log('Twilio not available:', e.message); }
}

const PARENT_AUTH_SECRET = process.env.SESSION_SECRET || 'allstars-parent-2026';

function createParentToken(phone) {
  const sig = crypto.createHmac('sha256', PARENT_AUTH_SECRET).update(phone).digest('hex').slice(0, 16);
  return phone + '.' + sig;
}

function verifyParentToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [phone, sig] = parts;
  const expected = crypto.createHmac('sha256', PARENT_AUTH_SECRET).update(phone).digest('hex').slice(0, 16);
  if (sig !== expected) return null;
  return phone;
}

function getParentTokenFromReq(req) {
  const header = req.headers.cookie || '';
  const match = header.match(/parent_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function setParentCookie(res, phone) {
  res.cookie('parent_token', createParentToken(phone), {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' && process.env.BASE_URL?.startsWith('https'),
    sameSite: 'lax',
  });
}

function clearParentCookie(res) {
  res.clearCookie('parent_token');
}

app.use(async (req, res, next) => {
  if (req.session.admin && req.session.impersonatePhone) {
    const phone = req.session.impersonatePhone;
    const account = await db.getParentAccountByPhone(phone);
    if (account) {
      const pPlayers = await db.getPlayersByPhone(phone);
      req.parentUser = { ...account, player_ids: pPlayers.filter(p => p.status === 'confirmed').map(p => p.id) };
      req.impersonating = true;
    }
  } else {
    const token = getParentTokenFromReq(req);
    const phone = verifyParentToken(token);
    if (phone) {
      const account = await db.getParentAccountByPhone(phone);
      if (account) {
        const pPlayers = await db.getPlayersByPhone(phone);
        req.parentUser = { ...account, player_ids: pPlayers.filter(p => p.status === 'confirmed').map(p => p.id) };
      }
    }
  }
  res.locals.impersonating = req.impersonating || false;
  res.locals.impersonateName = req.parentUser && req.impersonating ? req.parentUser.display_name : null;
  next();
});

app.use(async (req, res, next) => {
  res.locals.teamName = (await db.getSetting('team_name')) || 'Cal Ripken All-Stars';
  next();
});

app.use((req, res, next) => {
  if (!req.impersonating) return next();
  const origRender = res.render.bind(res);
  res.render = function(view, opts, callback) {
    const cb = callback || function(err, html) {
      if (err) return next(err);
      const banner = '<div style="position:fixed;top:0;left:0;right:0;z-index:9999;background:#7c3aed;color:#fff;text-align:center;padding:8px 16px;font-size:13px;font-weight:700;font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;gap:12px;box-shadow:0 2px 8px rgba(0,0,0,0.2);">' +
        '<span>Viewing as <strong>' + res.locals.impersonateName + '</strong></span>' +
        '<a href="/admin/stop-impersonate" style="background:#fff;color:#7c3aed;padding:4px 12px;border-radius:4px;text-decoration:none;font-size:12px;font-weight:800;">Exit</a>' +
        '</div><div style="height:40px;"></div>';
      res.send(html.replace(/<body([^>]*)>/, '<body$1>' + banner));
    };
    origRender(view, opts, cb);
  };
  next();
});

function calcEndTime(startTime, durationMinutes) {
  if (!startTime || !durationMinutes) return null;
  const [h, m] = startTime.split(':').map(Number);
  const total = h * 60 + m + Number(durationMinutes);
  const eh = Math.floor(total / 60) % 24;
  const em = total % 60;
  return String(eh).padStart(2, '0') + ':' + String(em).padStart(2, '0');
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

async function sendReminderEmail(to, player, event, link, reminderType, teamName) {
  if (!smtpTransport || !to) return;
  const tn = teamName || 'Cal Ripken All-Stars';
  const when = reminderType === '48h' ? 'in 2 days' : 'tomorrow';
  const startDate = new Date(event.start_date + 'T12:00:00');
  const dateStr = startDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const timeStr = event.start_time ? (() => { const [h,m] = event.start_time.split(':'); const hr = parseInt(h); return (hr % 12 || 12) + ':' + m + ' ' + (hr >= 12 ? 'PM' : 'AM'); })() : '';
  try {
    await smtpTransport.sendMail({
      from: `"${tn}" <${process.env.SMTP_USER}>`,
      to,
      subject: `RSVP Needed: ${event.title} — ${dateStr}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#1a2744;color:#fff;padding:24px;text-align:center;">
            <h1 style="margin:0;font-size:22px;">⚾ ${tn}</h1>
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
    const teamName = (await db.getSetting('team_name')) || 'Cal Ripken All-Stars';
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
            await sendReminderEmail(contact.value, player, event, link, reminderType, teamName);
          } else {
            const dateStr = new Date(event.start_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            await sendSMS(contact.value, `${teamName}: ${player.player_name} hasn't RSVP'd for ${event.title} on ${dateStr}. Tap to respond: ${link}`);
          }
          await db.logReminder(event.id, player.id, reminderType, contact.type, contact.value);
        }
      }
    }
  } catch (err) {
    console.error('Reminder check error:', err.message);
  }
}

async function sendConfirmationEmail(player, email, teamName) {
  if (!smtpTransport || !email) return;
  const tn = teamName || 'Cal Ripken All-Stars';
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  try {
    await smtpTransport.sendMail({
      from: `"${tn}" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `${player.player_name} — Team Selection`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#1a2744;color:#fff;padding:24px;text-align:center;">
            <h1 style="margin:0;font-size:22px;">⚾ ${tn}</h1>
            <p style="margin:4px 0 0;color:#d4a843;">Summer 2026 &middot; Major Division</p>
          </div>
          <div style="padding:24px;background:#f9fafb;border:1px solid #e5e7eb;">
            <p>Hi ${player.parent_name},</p>
            <p><strong>${player.player_name}</strong> has been selected for the <strong>Summer 2026 ${tn}</strong> team!</p>
            <p>Please confirm or decline participation using the link below:</p>
            <p style="text-align:center;margin:24px 0;">
              <a href="${baseUrl}/verify" style="background:#1a2744;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:bold;">Confirm Your Player</a>
            </p>
            <p style="font-size:14px;color:#6b7280;">Use your registered phone number <strong>${player.parent_phone.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3')}</strong> to look up your player and respond.</p>
            <p style="font-size:14px;color:#6b7280;">You can also fill out a player profile with positions, skills, and contact info for GameChanger.</p>
            <p>Thank you!<br>${tn} Coaching Staff</p>
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
  let parentRsvps = {};
  if (req.parentUser && req.parentUser.player_ids.length > 0) {
    for (const ev of teamEvents) {
      for (const pid of req.parentUser.player_ids) {
        const rsvp = await db.getRsvp(ev.id, pid);
        if (rsvp && rsvp.status !== 'pending') {
          parentRsvps[ev.id] = rsvp.status;
          break;
        }
      }
    }
  }
  res.render('index', { players, teamEvents, parentUser: req.parentUser || null, parentRsvps });
});

app.get('/event/:id', async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/');
  const rsvps = await db.getRsvpsForEvent(event.id);
  const players = await db.getAllPlayers();
  const confirmed = players.filter(p => p.status === 'confirmed');
  const isAdmin = !!req.session.admin;
  const staffPhone = req.parentUser ? req.parentUser.phone : null;
  const isStaff = isAdmin || (staffPhone ? !!(await db.getStaffByPhone(staffPhone)) : false);
  let drills = [], subEvents = [], lineup = [], subLineups = {}, lineupGrid = [], subGrids = {};
  if (event.event_type === 'practice') drills = await db.getDrills(event.id);
  if (event.event_type === 'tournament') {
    subEvents = await db.getSubEvents(event.id);
    for (const se of subEvents) {
      if (se.sub_type === 'game') {
        subLineups[se.id] = await db.getLineupForSubEvent(se.id);
        subGrids[se.id] = await db.getLineupGrid(null, se.id);
      }
    }
  }
  if (event.event_type === 'game') {
    lineup = await db.getLineupForEvent(event.id);
    lineupGrid = await db.getLineupGrid(event.id, null);
  }
  res.render('event-detail', { event, rsvps, confirmedPlayers: confirmed, isAdmin, isStaff, drills, subEvents, lineup, subLineups, lineupGrid, subGrids, POSITIONS: ['P','C','1B','2B','3B','SS','LF','CF','RF'], parentUser: req.parentUser || null });
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

app.get('/event/:id/practice-timer', async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/');
  const drills = await db.getDrills(event.id);
  res.render('practice-timer', { event, drills });
});

app.post('/event/:id/rsvp', async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/');
  const phone = req.parentUser ? req.parentUser.phone : normalizePhone(req.body.phone || '');
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

app.get('/verify', async (req, res) => {
  if (req.parentUser) {
    const players = await db.getPlayersByPhone(req.parentUser.phone);
    return res.render('verify', { players: players.length > 0 ? players : null, phone: req.parentUser.phone, error: null, success: null, parentUser: req.parentUser, hasAccount: true });
  }
  res.render('verify', { players: null, phone: '', error: null, success: null, parentUser: null, hasAccount: false });
});

app.post('/verify', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  if (phone.length !== 10) {
    return res.render('verify', {
      players: null, phone: req.body.phone || '', error: 'Please enter a valid 10-digit phone number.', success: null, parentUser: req.parentUser || null, hasAccount: false
    });
  }

  const players = await db.getPlayersByPhone(phone);
  if (players.length === 0) {
    return res.render('verify', {
      players: null, phone: req.body.phone || '',
      error: 'No players found for that phone number. Please use the number your league has on file.',
      success: null, parentUser: req.parentUser || null, hasAccount: false
    });
  }

  const hasAccount = !!(await db.getParentAccountByPhone(phone));
  res.render('verify', { players, phone, error: null, success: null, parentUser: req.parentUser || null, hasAccount });
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
      success: null, parentUser: req.parentUser || null, hasAccount: false
    });
  }

  await db.updateStatus(Number(player_id), status);

  const players = await db.getPlayersByPhone(normalized);
  const action = status === 'confirmed' ? 'confirmed' : 'declined';
  const hasAccount = !!(await db.getParentAccountByPhone(normalized));
  res.render('verify', {
    players, phone: normalized,
    error: null,
    success: `${player.player_name} has been ${action} for the ${res.locals.teamName} team. You can change this anytime.`,
    parentUser: req.parentUser || null, hasAccount
  });
});

// --- Parent Account Routes ---

app.post('/parent/register', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  const { password, confirm_password } = req.body;
  const players = await db.getPlayersByPhone(phone);
  if (players.length === 0) return res.redirect('/verify');

  const existing = await db.getParentAccountByPhone(phone);
  if (existing) {
    const hasAccount = true;
    return res.render('verify', { players, phone, error: 'An account already exists for this phone number. Use the login page.', success: null, parentUser: req.parentUser || null, hasAccount });
  }

  if (!password || password.length < 6) {
    return res.render('verify', { players, phone, error: 'Password must be at least 6 characters.', success: null, parentUser: req.parentUser || null, hasAccount: false });
  }
  if (password !== confirm_password) {
    return res.render('verify', { players, phone, error: 'Passwords do not match.', success: null, parentUser: req.parentUser || null, hasAccount: false });
  }

  const displayName = players[0].parent_name;
  const hash = bcrypt.hashSync(password, 10);
  await db.createParentAccount(phone, displayName, hash);
  setParentCookie(res, phone);
  res.redirect('/?welcome=1');
});

app.get('/parent/login', (req, res) => {
  if (req.parentUser) return res.redirect('/verify');
  res.render('parent-login', { error: null });
});

app.post('/parent/login', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  const { password } = req.body;
  if (phone.length !== 10) {
    return res.render('parent-login', { error: 'Please enter a valid 10-digit phone number.' });
  }
  const account = await db.getParentAccountByPhone(phone);
  if (!account || !bcrypt.compareSync(password || '', account.password_hash)) {
    return res.render('parent-login', { error: 'Invalid phone number or password.' });
  }
  setParentCookie(res, phone);
  res.redirect('/');
});

app.get('/parent/logout', (req, res) => {
  clearParentCookie(res);
  res.redirect('/');
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
    jersey_number: (req.body.jersey_number || '').trim() || null,
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
  const savedLocations = await db.getAllSavedLocations();
  const rsvpRows = await db.getRsvpCountsAll();
  const rsvpCounts = {};
  rsvpRows.forEach(r => {
    if (!rsvpCounts[r.team_event_id]) rsvpCounts[r.team_event_id] = { yes: 0, no: 0, maybe: 0 };
    if (r.status === 'yes') rsvpCounts[r.team_event_id].yes = r.cnt;
    else if (r.status === 'no') rsvpCounts[r.team_event_id].no = r.cnt;
    else if (r.status === 'maybe') rsvpCounts[r.team_event_id].maybe = r.cnt;
  });
  res.render('admin', {
    players, staff, confirmed, declined, pending, total: players.length, allEvents, teamEvents, savedLocations, rsvpCounts,
    adminUser: req.session.admin,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

app.post('/admin/status', requireAdmin, async (req, res) => {
  const { player_id, status, redirect } = req.body;
  if (!['confirmed', 'declined', 'pending'].includes(status)) {
    return res.redirect('/admin?error=Invalid+status');
  }
  await db.updateStatus(Number(player_id), status);
  const player = await db.getPlayer(Number(player_id));
  if (redirect) return res.redirect(redirect + '?success=' + encodeURIComponent(`${player.player_name} set to ${status}`));
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
    sendConfirmationEmail(newPlayer, newPlayer.parent_email, res.locals.teamName);
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

  await sendConfirmationEmail(player, email, res.locals.teamName);
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
  const { event_type, title, start_date, start_time, end_date, end_time, duration, location_name, address, notes, hotel_info, carpool_info, save_location, opponent_name } = req.body;
  const dates = req.body.dates;
  const multiDates = dates ? (Array.isArray(dates) ? dates : [dates]).filter(Boolean).sort() : [];

  if (!title || !title.trim() || (!start_date && multiDates.length === 0)) {
    const dest = req.session.admin ? '/admin' : '/staff/dashboard?phone=' + req.body.staff_phone;
    return res.redirect(dest + (dest.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent('Event title and at least one date are required.'));
  }

  const resolvedEndTime = duration ? calcEndTime(start_time, duration) : (end_time || null);

  const eventData = {
    event_type: event_type || 'practice',
    title: title.trim(),
    start_time: start_time || null,
    end_time: resolvedEndTime,
    location_name: (location_name || '').trim() || null,
    address: (address || '').trim() || null,
    notes: (notes || '').trim() || null,
    hotel_info: (hotel_info || '').trim() || null,
    carpool_info: (carpool_info || '').trim() || null,
    opponent_name: (opponent_name || '').trim() || null,
  };

  const locName = (location_name || '').trim();
  const locAddr = (address || '').trim();
  if (save_location && locName && locAddr) {
    await db.addSavedLocation(locName, locAddr);
  }

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
  const { event_id, event_type, title, start_date, start_time, end_date, end_time, duration, location_name, address, notes, hotel_info, carpool_info, save_location, opponent_name } = req.body;
  if (!title || !title.trim() || !start_date) {
    const dest = req.session.admin ? '/admin' : '/staff/dashboard?phone=' + req.body.staff_phone;
    return res.redirect(dest + (dest.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent('Event title and start date are required.'));
  }
  const resolvedEndTime = duration ? calcEndTime(start_time, duration) : (end_time || null);
  await db.updateTeamEvent(Number(event_id), {
    event_type: event_type || 'practice',
    title: title.trim(),
    start_date,
    start_time: start_time || null,
    end_date: end_date || null,
    end_time: resolvedEndTime,
    location_name: (location_name || '').trim() || null,
    address: (address || '').trim() || null,
    notes: (notes || '').trim() || null,
    hotel_info: (hotel_info || '').trim() || null,
    carpool_info: (carpool_info || '').trim() || null,
    opponent_name: (opponent_name || '').trim() || null,
  });
  const locName = (location_name || '').trim();
  const locAddr = (address || '').trim();
  if (save_location && locName && locAddr) {
    await db.addSavedLocation(locName, locAddr);
  }
  const dest = req.session.admin ? '/admin' : '/staff/dashboard?phone=' + req.body.staff_phone;
  res.redirect(dest + (dest.includes('?') ? '&' : '?') + 'success=' + encodeURIComponent(`"${title.trim()}" updated`));
});

app.post('/admin/remove-team-event', requireAdmin, async (req, res) => {
  await db.removeTeamEvent(Number(req.body.event_id));
  res.redirect('/admin?success=Event+removed');
});

app.post('/admin/remove-saved-location', requireAdmin, async (req, res) => {
  await db.removeSavedLocation(Number(req.body.location_id));
  res.redirect('/admin?success=Location+removed');
});

app.post('/admin/update-score', requireAdmin, async (req, res) => {
  const { event_id, our_score, opponent_score } = req.body;
  await db.updateGameScore(Number(event_id), parseInt(our_score) || 0, parseInt(opponent_score) || 0);
  res.redirect('/event/' + event_id);
});

app.post('/admin/clear-score', requireAdmin, async (req, res) => {
  const { event_id } = req.body;
  await db.clearGameScore(Number(event_id));
  res.redirect('/event/' + event_id);
});

app.post('/event/:id/clear-lineup', requireAdmin, async (req, res) => {
  await db.clearLineupGrid(Number(req.params.id), null);
  res.json({ ok: true });
});

app.post('/event/:id/clear-player-lineup', requireAdmin, async (req, res) => {
  const { player_id } = req.body;
  await db.clearPlayerFromLineupGrid(Number(req.params.id), null, Number(player_id));
  res.json({ ok: true });
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
    coach_notes: (req.body.coach_notes || '').trim() || null,
  });
  res.redirect('/event/' + event.id);
});

app.post('/event/:id/drill/:drillId/update', requireAdmin, async (req, res) => {
  await db.updateDrill(Number(req.params.drillId), {
    drill_name: (req.body.drill_name || '').trim() || 'Drill',
    description: (req.body.description || '').trim() || null,
    duration_minutes: parseInt(req.body.duration_minutes) || 10,
    sort_order: parseInt(req.body.sort_order) || 0,
    coach_notes: (req.body.coach_notes || '').trim() || null,
  });
  res.redirect('/event/' + req.params.id);
});

app.post('/event/:id/drill/reorder', requireAdmin, async (req, res) => {
  const order = req.body.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Invalid order' });
  const drills = await db.getDrills(Number(req.params.id));
  for (let i = 0; i < order.length; i++) {
    const d = drills.find(x => x.id === order[i]);
    if (d) await db.updateDrill(d.id, { drill_name: d.drill_name, description: d.description, duration_minutes: d.duration_minutes, sort_order: i, coach_notes: d.coach_notes });
  }
  res.json({ ok: true });
});

app.post('/event/:id/drill/:drillId/delete', requireAdmin, async (req, res) => {
  await db.removeDrill(Number(req.params.drillId));
  res.redirect('/event/' + req.params.id);
});

app.post('/event/:id/drill/parse-excel', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetNames = wb.SheetNames;
    const sheets = {};
    for (const name of sheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
      if (rows.length > 0) sheets[name] = { columns: Object.keys(rows[0]), preview: rows.slice(0, 5) };
    }
    res.json({ sheets });
  } catch (e) {
    res.json({ error: 'Could not parse file. Make sure it is a valid .xlsx or .xls file.' });
  }
});

app.post('/event/:id/drill/import', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.redirect('/event/' + req.params.id);
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/admin');
  const { sheet, col_name, col_desc, col_duration } = req.body;
  const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  const ws = wb.Sheets[sheet || wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  const existing = await db.getDrills(event.id);
  let order = existing.length;
  for (const row of rows) {
    const name = String(row[col_name] || '').trim();
    if (!name) continue;
    await db.addDrill({
      team_event_id: event.id,
      drill_name: name,
      description: col_desc ? String(row[col_desc] || '').trim() || null : null,
      duration_minutes: col_duration ? (parseInt(row[col_duration]) || 10) : 10,
      sort_order: order++,
    });
  }
  res.redirect('/event/' + event.id);
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

app.post('/event/:id/lineup-grid', requireAdmin, async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.status(404).json({ error: 'Not found' });
  const { entries } = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'Invalid data' });
  await db.saveLineupGrid(event.id, null, entries);
  res.json({ ok: true });
});

app.post('/event/:id/batting-nine', requireAdmin, async (req, res) => {
  const { batting_all } = req.body;
  await db.updateBattingAll(Number(req.params.id), !!batting_all);
  res.json({ ok: true });
});

app.post('/event/:id/sub-event/:subId/lineup-grid', requireAdmin, async (req, res) => {
  const subId = Number(req.params.subId);
  const { entries } = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'Invalid data' });
  await db.saveLineupGrid(null, subId, entries);
  res.json({ ok: true });
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

app.get('/admin/blank-lineup', requireAdmin, async (req, res) => {
  const players = await db.getAllPlayers();
  const rosterSize = players.filter(p => p.status === 'confirmed').length;
  res.render('blank-lineup', { rosterSize });
});

app.post('/admin/jersey-number', requireAdmin, async (req, res) => {
  const { player_id, jersey_number } = req.body;
  await db.updateJerseyNumber(Number(player_id), (jersey_number || '').trim() || null);
  res.json({ ok: true });
});

// --- Admin Settings ---

app.get('/admin/settings', requireAdmin, async (req, res) => {
  const admins = await db.getAllAdmins();
  res.render('admin-settings', {
    adminUser: req.session.admin,
    admins,
    teamName: res.locals.teamName,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

app.post('/admin/settings/team-name', requireAdmin, async (req, res) => {
  await db.setSetting('team_name', (req.body.team_name || '').trim());
  res.redirect('/admin/settings?success=Team+name+updated.');
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

// --- Team Messages ---

app.get('/messages', async (req, res) => {
  const topics = await db.getAllMessages();
  const topicReplies = {};
  for (const t of topics) {
    topicReplies[t.id] = await db.getTopicReplies(t.id);
  }
  const isAdmin = !!req.session.admin;
  res.render('messages', { topics, topicReplies, isAdmin, parentUser: req.parentUser || null, error: req.query.error || null, success: req.query.success || null });
});

app.post('/messages', async (req, res) => {
  const isAdmin = !!req.session.admin;
  const message = (req.body.message || '').trim();
  if (!message) return res.redirect('/messages?error=' + encodeURIComponent('Message cannot be empty.'));

  let authorName, authorType;
  if (isAdmin) {
    authorName = req.session.admin.username;
    authorType = 'admin';
  } else if (req.parentUser) {
    authorName = req.parentUser.display_name;
    authorType = 'parent';
  } else {
    const phone = normalizePhone(req.body.phone || '');
    if (phone.length !== 10) return res.redirect('/messages?error=' + encodeURIComponent('Enter your 10-digit phone number to post.'));
    const players = await db.getPlayersByPhone(phone);
    const staff = await db.getStaffByPhone(phone);
    if (players.length === 0 && !staff) return res.redirect('/messages?error=' + encodeURIComponent('Phone number not recognized.'));
    if (staff) { authorName = staff.name; authorType = 'staff'; }
    else { authorName = players[0].parent_name; authorType = 'parent'; }
  }

  await db.addMessage({ author_name: authorName, author_type: authorType, message });
  res.redirect('/messages');
});

app.post('/messages/:id/reply', async (req, res) => {
  const topicId = Number(req.params.id);
  const isAdmin = !!req.session.admin;
  const message = (req.body.message || '').trim();
  if (!message) return res.redirect('/messages');

  let authorName, authorType;
  if (isAdmin) { authorName = req.session.admin.username; authorType = 'admin'; }
  else if (req.parentUser) { authorName = req.parentUser.display_name; authorType = 'parent'; }
  else return res.redirect('/messages');

  await db.addMessage({ author_name: authorName, author_type: authorType, message, parent_id: topicId });
  res.redirect('/messages');
});

app.post('/messages/delete', requireAdmin, async (req, res) => {
  await db.removeMessage(Number(req.body.message_id));
  res.redirect('/messages');
});

app.post('/messages/pin', requireAdmin, async (req, res) => {
  await db.togglePinMessage(Number(req.body.message_id));
  res.redirect('/messages');
});

// --- Live Scoring System ---

function requireScoreKeeper(req, res, next) {
  const token = req.query.token || req.session.scoreToken;
  if (!token) return res.status(401).send('Scoring access required. Use your scorekeeper link.');
  req.scoreToken = token;
  if (!req.session.scoreToken) req.session.scoreToken = token;
  next();
}

app.get('/admin/scorekeepers', requireAdmin, async (req, res) => {
  const keepers = await db.getAllScoreKeepers();
  res.json(keepers);
});

app.post('/admin/scorekeepers', requireAdmin, async (req, res) => {
  const { name, phone, email } = req.body;
  const token = crypto.randomBytes(24).toString('hex');
  await db.addScoreKeeper({ name, phone: phone || null, email: email || null, access_token: token });
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const link = `${baseUrl}/score/${token}`;
  if (email && smtpTransport) {
    try {
      await smtpTransport.sendMail({
        from: `"Cal Ripken All-Stars" <${process.env.SMTP_USER}>`,
        to: email,
        subject: 'Scorekeeper Access — Cal Ripken All-Stars',
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;"><div style="background:#1a2744;color:#fff;padding:24px;text-align:center;"><h1 style="margin:0;font-size:22px;">Cal Ripken All-Stars</h1><p style="margin:4px 0 0;color:#d4a843;">Live Scoring Access</p></div><div style="padding:24px;background:#f9fafb;border:1px solid #e5e7eb;"><p>Hi ${name},</p><p>You've been added as a scorekeeper. Use this link to access the live scoring system whenever there's an active game:</p><p style="text-align:center;margin:24px 0;"><a href="${link}" style="background:#1a2744;color:#fff;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:bold;">Open Scoring</a></p><p style="font-size:13px;color:#6b7280;">Or copy: ${link}</p></div></div>`
      });
    } catch (e) { console.error('Scorekeeper email failed:', e.message); }
  }
  if (phone) {
    await sendSMS(phone, `Cal Ripken All-Stars: You've been added as a scorekeeper. Access live scoring here: ${link}`);
  }
  res.json({ ok: true, token, link });
});

app.post('/admin/scorekeepers/:id/delete', requireAdmin, async (req, res) => {
  await db.removeScoreKeeper(Number(req.params.id));
  res.json({ ok: true });
});

// --- User Account Management ---

app.get('/admin/accounts', requireAdmin, async (req, res) => {
  const accounts = await db.getAllParentAccounts();
  const players = await db.getAllPlayers();
  const result = accounts.map(a => {
    const linked = players.filter(p => normalizePhone(p.parent_phone) === normalizePhone(a.phone));
    return { ...a, players: linked.map(p => ({ id: p.id, name: p.player_name })) };
  });
  res.json(result);
});

app.post('/admin/accounts/create', requireAdmin, async (req, res) => {
  const { phone, display_name, password, player_ids } = req.body;
  const normalized = normalizePhone(phone || '');
  if (normalized.length !== 10) return res.json({ ok: false, error: 'Invalid phone number.' });
  if (!display_name || !display_name.trim()) return res.json({ ok: false, error: 'Name is required.' });
  if (!password || password.length < 6) return res.json({ ok: false, error: 'Password must be at least 6 characters.' });

  const existing = await db.getParentAccountByPhone(normalized);
  if (existing) return res.json({ ok: false, error: 'An account already exists for this phone number.' });

  const hash = bcrypt.hashSync(password, 10);
  await db.createParentAccount(normalized, display_name.trim(), hash);

  if (player_ids && player_ids.length > 0) {
    for (const pid of player_ids) {
      await db.updatePlayerParentPhone(Number(pid), normalized);
    }
  }
  res.json({ ok: true });
});

app.post('/admin/accounts/:id/update', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { display_name, phone } = req.body;
  const account = await db.getParentAccountById(id);
  if (!account) return res.json({ ok: false, error: 'Account not found.' });

  if (display_name && display_name.trim()) {
    await db.updateParentAccountName(id, display_name.trim());
  }
  if (phone) {
    const normalized = normalizePhone(phone);
    if (normalized.length !== 10) return res.json({ ok: false, error: 'Invalid phone number.' });
    const clash = await db.getParentAccountByPhone(normalized);
    if (clash && clash.id !== id) return res.json({ ok: false, error: 'Phone already in use by another account.' });
    const oldPhone = account.phone;
    await db.updateParentAccountPhone(id, normalized);
    const linkedPlayers = await db.getPlayersByPhone(oldPhone);
    for (const p of linkedPlayers) {
      await db.updatePlayerParentPhone(p.id, normalized);
    }
  }
  res.json({ ok: true });
});

app.post('/admin/accounts/:id/reset-password', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { password } = req.body;
  if (!password || password.length < 6) return res.json({ ok: false, error: 'Password must be at least 6 characters.' });
  const hash = bcrypt.hashSync(password, 10);
  await db.updateParentAccountPassword(id, hash);
  res.json({ ok: true });
});

app.post('/admin/accounts/:id/link-player', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { player_id } = req.body;
  const account = await db.getParentAccountById(id);
  if (!account) return res.json({ ok: false, error: 'Account not found.' });
  await db.updatePlayerParentPhone(Number(player_id), account.phone);
  res.json({ ok: true });
});

app.post('/admin/accounts/:id/unlink-player', requireAdmin, async (req, res) => {
  const { player_id } = req.body;
  await db.updatePlayerParentPhone(Number(player_id), '');
  res.json({ ok: true });
});

app.post('/admin/accounts/:id/delete', requireAdmin, async (req, res) => {
  await db.deleteParentAccount(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/admin/impersonate/:id', requireAdmin, async (req, res) => {
  const account = await db.getParentAccountById(Number(req.params.id));
  if (!account) return res.redirect('/admin');
  req.session.impersonatePhone = account.phone;
  res.redirect('/');
});

app.get('/admin/stop-impersonate', (req, res) => {
  delete req.session.impersonatePhone;
  res.redirect('/admin');
});

app.get('/score/:token', async (req, res) => {
  const keeper = await db.getScoreKeeperByToken(req.params.token);
  if (!keeper) return res.status(403).send('Invalid scorekeeper link.');
  req.session.scoreToken = req.params.token;
  const games = await db.getAllActiveGames();
  if (games.length === 1) return res.redirect('/game/' + games[0].id + '/score?token=' + req.params.token);
  res.render('score-home', { keeper, games, token: req.params.token });
});

app.get('/game/setup/:eventId', requireAdmin, async (req, res) => {
  const eventId = Number(req.params.eventId);
  const subEventId = req.query.sub ? Number(req.query.sub) : null;
  const event = subEventId ? await db.getSubEvent(subEventId) : await db.getTeamEvent(eventId);
  if (!event) return res.redirect('/admin');
  const parentEvent = subEventId ? await db.getTeamEvent(eventId) : null;
  const players = (await db.getAllPlayers()).filter(p => p.status === 'confirmed');
  const grid = subEventId
    ? await db.getLineupGrid(null, subEventId)
    : await db.getLineupGrid(eventId, null);
  const existingGame = await db.getLiveGameByEvent(eventId, subEventId);
  res.render('game-setup', { event, parentEvent, eventId, subEventId, players, grid, existingGame });
});

app.post('/game/create', requireAdmin, async (req, res) => {
  const { team_event_id, sub_event_id, home_away, opp_team_name, total_innings, roster, opponent } = req.body;
  const game = await db.createLiveGame({
    team_event_id: team_event_id ? Number(team_event_id) : null,
    sub_event_id: sub_event_id ? Number(sub_event_id) : null,
    home_away: home_away || 'home',
    opp_team_name: opp_team_name || 'Opponent',
    total_innings: total_innings ? Number(total_innings) : 6,
  });
  if (roster && Array.isArray(roster)) {
    await db.setGameRoster(game.id, roster.map((r, i) => ({
      player_id: Number(r.player_id),
      batting_order: i + 1,
      current_position: r.position ? Number(r.position) : null,
    })));
  }
  if (opponent && Array.isArray(opponent)) {
    await db.setOppRoster(game.id, opponent.map((o, i) => ({
      player_name: o.name || `Player ${i + 1}`,
      jersey_number: o.jersey || null,
      batting_order: i + 1,
      current_position: o.position ? Number(o.position) : null,
    })));
  }
  res.json({ ok: true, gameId: game.id });
});

app.post('/game/:id/start', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const game = await db.getLiveGame(id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const half = game.home_away === 'home' ? 'top' : 'bot';
  await db.updateGameState(id, { status: 'active', current_half: half, started_at: new Date().toISOString() });
  res.json({ ok: true });
});

app.post('/game/:id/end', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const game = await db.getLiveGame(id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  await db.updateGameState(id, { status: 'final', ended_at: new Date().toISOString() });
  if (game.team_event_id) {
    await db.updateGameScore(game.team_event_id, game.our_score, game.opp_score);
  }
  res.json({ ok: true });
});

app.get('/game/:id/score', requireScoreKeeper, async (req, res) => {
  const game = await db.getLiveGame(Number(req.params.id));
  if (!game) return res.status(404).send('Game not found');
  const keeper = await db.getScoreKeeperByToken(req.scoreToken);
  const roster = await db.getGameRoster(game.id);
  const oppRoster = await db.getOppRoster(game.id);
  res.render('game-score', { game, keeper, roster, oppRoster, token: req.scoreToken });
});

app.get('/api/game/:id/state', async (req, res) => {
  const game = await db.getLiveGame(Number(req.params.id));
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const roster = await db.getGameRoster(game.id);
  const oppRoster = await db.getOppRoster(game.id);
  const atBats = await db.getAtBatsForGame(game.id);
  const currentAB = game.current_at_bat_id ? await db.getAtBat(game.current_at_bat_id) : null;
  const currentPitches = currentAB ? await db.getPitchesForAtBat(currentAB.id) : [];
  const undoCount = await db.getUndoCount(game.id);

  const pitchCounts = {};
  for (const r of roster) {
    pitchCounts[r.player_id] = await db.getPitchCountForPitcher(game.id, r.player_id);
  }

  const inningScores = { us: {}, opp: {} };
  for (const ab of atBats) {
    if (ab.result) {
      const key = ab.is_our_team ? 'us' : 'opp';
      if (!inningScores[key][ab.inning]) inningScores[key][ab.inning] = 0;
      inningScores[key][ab.inning] += ab.rbi_count || 0;
    }
  }

  res.json({ game, roster, oppRoster, atBats, currentAB, currentPitches, undoCount, pitchCounts, inningScores });
});

app.post('/api/game/:id/pitch', requireScoreKeeper, async (req, res) => {
  const gameId = Number(req.params.id);
  const game = await db.getLiveGame(gameId);
  if (!game || game.status !== 'active') return res.status(400).json({ error: 'Game not active' });

  const { result } = req.body;
  const prevState = JSON.stringify({ balls: game.balls, strikes: game.strikes, outs: game.outs, current_at_bat_id: game.current_at_bat_id });

  let currentAB = game.current_at_bat_id ? await db.getAtBat(game.current_at_bat_id) : null;

  if (!currentAB) {
    const weAreBatting = (game.home_away === 'home' && game.current_half === 'bot') || (game.home_away === 'away' && game.current_half === 'top');
    const roster = weAreBatting ? await db.getGameRoster(gameId) : await db.getOppRoster(gameId);
    const batterIdx = weAreBatting ? game.current_batter_us : game.current_batter_opp;
    const batter = roster[batterIdx % roster.length];

    let pitcherName = null, pitcherId = null;
    if (weAreBatting) {
      pitcherName = game.opp_pitcher_name;
    } else {
      if (game.current_pitcher_us) {
        const ourRoster = await db.getGameRoster(gameId);
        const pitcher = ourRoster.find(r => r.player_id === game.current_pitcher_us);
        if (pitcher) { pitcherName = pitcher.player_name; pitcherId = pitcher.player_id; }
      }
    }

    currentAB = await db.createAtBat({
      game_id: gameId, inning: game.current_inning, half: game.current_half,
      is_our_team: weAreBatting ? 1 : 0,
      batter_player_id: weAreBatting ? batter.player_id : null,
      batter_name: weAreBatting ? batter.player_name : batter.player_name,
      pitcher_player_id: pitcherId,
      pitcher_name: pitcherName,
      batting_order_pos: batterIdx % roster.length,
      runners_on_base: JSON.stringify({ first: game.runner_first, second: game.runner_second, third: game.runner_third }),
    });
    await db.updateGameState(gameId, { current_at_bat_id: currentAB.id, balls: 0, strikes: 0 });
    game.balls = 0;
    game.strikes = 0;
    game.current_at_bat_id = currentAB.id;
  }

  const weAreBatting = currentAB.is_our_team === 1;
  const lastPitch = await db.getLastPitchInAB(currentAB.id);
  const pitchNum = lastPitch ? lastPitch.pitch_number_in_ab + 1 : 1;

  const pitcherId = weAreBatting ? null : (game.current_pitcher_us || null);
  let pitcherName = null;
  if (!weAreBatting && pitcherId) {
    const ourRoster = await db.getGameRoster(gameId);
    const p = ourRoster.find(r => r.player_id === pitcherId);
    if (p) pitcherName = p.player_name;
  } else if (weAreBatting) {
    pitcherName = game.opp_pitcher_name;
  }

  await db.recordPitch({
    game_id: gameId, at_bat_id: currentAB.id, inning: game.current_inning, half: game.current_half,
    pitcher_player_id: weAreBatting ? null : pitcherId,
    pitcher_name: pitcherName,
    batter_player_id: currentAB.batter_player_id,
    batter_name: currentAB.batter_name,
    pitch_number_in_ab: pitchNum, result,
    balls_before: game.balls, strikes_before: game.strikes,
    runners_on: JSON.stringify({ first: game.runner_first, second: game.runner_second, third: game.runner_third }),
  });

  let newBalls = game.balls, newStrikes = game.strikes;
  let abResult = null;

  if (result === 'ball') {
    newBalls++;
    if (newBalls >= 4) abResult = 'BB';
  } else if (result === 'called_strike' || result === 'swinging_strike') {
    newStrikes++;
    if (newStrikes >= 3) abResult = 'K';
  } else if (result === 'foul' || result === 'foul_tip') {
    if (newStrikes < 2) newStrikes++;
  } else if (result === 'hbp') {
    abResult = 'HBP';
  } else if (result === 'in_play') {
    abResult = 'in_play';
  }

  await db.pushUndo(gameId, 'pitch', JSON.stringify({ pitch_result: result, at_bat_id: currentAB.id }), prevState);

  if (abResult && abResult !== 'in_play') {
    await db.updateAtBat(currentAB.id, { result: abResult, total_pitches: pitchNum, balls_in_count: newBalls, strikes_in_count: newStrikes });
    const outsOnPlay = abResult === 'K' ? 1 : 0;
    if (outsOnPlay) await db.updateAtBat(currentAB.id, { outs_on_play: 1 });
    const newOuts = game.outs + outsOnPlay;

    const updates = { balls: 0, strikes: 0, current_at_bat_id: null };
    const batterKey = weAreBatting ? 'current_batter_us' : 'current_batter_opp';
    const roster = weAreBatting ? await db.getGameRoster(gameId) : await db.getOppRoster(gameId);
    updates[batterKey] = ((weAreBatting ? game.current_batter_us : game.current_batter_opp) + 1) % roster.length;

    if (abResult === 'BB' || abResult === 'HBP') {
      let rf = game.runner_first, rs = game.runner_second, rt = game.runner_third;
      if (rf) {
        if (rs) {
          if (rt) {
            updates.our_score = weAreBatting ? game.our_score + 1 : game.our_score;
            updates.opp_score = weAreBatting ? game.opp_score : game.opp_score + 1;
            await db.updateAtBat(currentAB.id, { rbi_count: 1 });
          }
          rt = rs;
        }
        rs = rf;
      }
      rf = currentAB.batter_name;
      updates.runner_first = rf;
      updates.runner_second = rs;
      updates.runner_third = rt;
    }

    if (newOuts >= 3) {
      const nextHalf = game.current_half === 'top' ? 'bot' : 'top';
      const nextInning = game.current_half === 'bot' ? game.current_inning + 1 : game.current_inning;
      updates.outs = 0;
      updates.current_half = nextHalf;
      updates.current_inning = nextInning;
      updates.runner_first = null;
      updates.runner_second = null;
      updates.runner_third = null;
    } else {
      updates.outs = newOuts;
    }

    await db.updateGameState(gameId, updates);
  } else if (abResult === 'in_play') {
    await db.updateGameState(gameId, { balls: newBalls, strikes: newStrikes });
  } else {
    await db.updateGameState(gameId, { balls: newBalls, strikes: newStrikes });
  }

  res.json({ ok: true, abResult });
});

app.post('/api/game/:id/at-bat-result', requireScoreKeeper, async (req, res) => {
  const gameId = Number(req.params.id);
  const game = await db.getLiveGame(gameId);
  if (!game || game.status !== 'active') return res.status(400).json({ error: 'Game not active' });

  const { result, hit_type, is_hard_contact, rbi_count, outs_on_play, error_position, error_player_id, fielders_involved } = req.body;
  const currentAB = game.current_at_bat_id ? await db.getAtBat(game.current_at_bat_id) : null;
  if (!currentAB) return res.status(400).json({ error: 'No active at-bat' });

  const weAreBatting = currentAB.is_our_team === 1;
  const prevState = JSON.stringify({ outs: game.outs, our_score: game.our_score, opp_score: game.opp_score, runner_first: game.runner_first, runner_second: game.runner_second, runner_third: game.runner_third, current_at_bat_id: game.current_at_bat_id });

  const lastPitch = await db.getLastPitchInAB(currentAB.id);
  const totalPitches = lastPitch ? lastPitch.pitch_number_in_ab : 0;

  await db.updateAtBat(currentAB.id, {
    result, hit_type: hit_type || null, is_hard_contact: is_hard_contact ? 1 : 0,
    rbi_count: rbi_count || 0, outs_on_play: outs_on_play || 0,
    error_position: error_position || null, error_player_id: error_player_id || null,
    fielders_involved: fielders_involved || null,
    total_pitches: totalPitches, balls_in_count: game.balls, strikes_in_count: game.strikes,
  });

  await db.pushUndo(gameId, 'at_bat_result', JSON.stringify({ at_bat_id: currentAB.id, result }), prevState);

  const newOuts = game.outs + (outs_on_play || 0);
  const rbi = rbi_count || 0;
  const updates = { balls: 0, strikes: 0, current_at_bat_id: null };

  if (rbi > 0) {
    if (weAreBatting) updates.our_score = game.our_score + rbi;
    else updates.opp_score = game.opp_score + rbi;
  }

  const batterKey = weAreBatting ? 'current_batter_us' : 'current_batter_opp';
  const roster = weAreBatting ? await db.getGameRoster(gameId) : await db.getOppRoster(gameId);
  updates[batterKey] = ((weAreBatting ? game.current_batter_us : game.current_batter_opp) + 1) % roster.length;

  const runners = { first: null, second: null, third: null };
  const runnersBody = req.body.runners;
  if (runnersBody) {
    runners.first = runnersBody.first || null;
    runners.second = runnersBody.second || null;
    runners.third = runnersBody.third || null;
  }
  updates.runner_first = runners.first;
  updates.runner_second = runners.second;
  updates.runner_third = runners.third;

  if (newOuts >= 3) {
    const nextHalf = game.current_half === 'top' ? 'bot' : 'top';
    const nextInning = game.current_half === 'bot' ? game.current_inning + 1 : game.current_inning;
    updates.outs = 0;
    updates.current_half = nextHalf;
    updates.current_inning = nextInning;
    updates.runner_first = null;
    updates.runner_second = null;
    updates.runner_third = null;
  } else {
    updates.outs = newOuts;
  }

  await db.updateGameState(gameId, updates);
  res.json({ ok: true });
});

app.post('/api/game/:id/update-state', requireScoreKeeper, async (req, res) => {
  const gameId = Number(req.params.id);
  const game = await db.getLiveGame(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const allowed = ['runner_first', 'runner_second', 'runner_third', 'outs', 'balls', 'strikes',
    'our_score', 'opp_score', 'current_pitcher_us', 'opp_pitcher_name', 'current_inning', 'current_half'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  if (Object.keys(updates).length > 0) {
    await db.updateGameState(gameId, updates);
  }
  res.json({ ok: true });
});

app.post('/api/game/:id/undo', requireScoreKeeper, async (req, res) => {
  const gameId = Number(req.params.id);
  const entry = await db.popUndo(gameId);
  if (!entry) return res.status(400).json({ error: 'Nothing to undo' });

  if (entry.prev_game_state) {
    const prev = JSON.parse(entry.prev_game_state);
    await db.updateGameState(gameId, prev);
  }

  const data = entry.action_data ? JSON.parse(entry.action_data) : {};
  if (entry.action_type === 'pitch' && data.at_bat_id) {
    const lastPitch = await db.getLastPitchInAB(data.at_bat_id);
    if (lastPitch) await db.deletePitch(lastPitch.id);
    const ab = await db.getAtBat(data.at_bat_id);
    if (ab && ab.result) {
      await db.updateAtBat(data.at_bat_id, { result: null, total_pitches: 0, outs_on_play: 0, rbi_count: 0 });
    }
  } else if (entry.action_type === 'at_bat_result' && data.at_bat_id) {
    await db.updateAtBat(data.at_bat_id, { result: null, hit_type: null, is_hard_contact: null, rbi_count: 0, outs_on_play: 0, error_position: null, error_player_id: null, fielders_involved: null });
  }

  res.json({ ok: true });
});

app.post('/api/game/:id/roster-update', requireScoreKeeper, async (req, res) => {
  const gameId = Number(req.params.id);
  const { roster_id, position } = req.body;
  if (roster_id) {
    await db.updateRosterEntry(Number(roster_id), { current_position: position ? Number(position) : null });
  }
  res.json({ ok: true });
});

app.get('/game/:id/coach', async (req, res) => {
  const game = await db.getLiveGame(Number(req.params.id));
  if (!game) return res.status(404).send('Game not found');
  res.render('game-coach', { game });
});

app.get('/api/game/:id/dashboard', async (req, res) => {
  const gameId = Number(req.params.id);
  const game = await db.getLiveGame(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const roster = await db.getGameRoster(gameId);
  const oppRoster = await db.getOppRoster(gameId);
  const atBats = await db.getAtBatsForGame(gameId);
  const allPitches = await db.getPitchesForGame(gameId);

  const pitchCounts = {};
  const pitcherStats = {};
  for (const r of roster) {
    const cnt = await db.getPitchCountForPitcher(gameId, r.player_id);
    pitchCounts[r.player_id] = cnt;
    if (cnt > 0) {
      const pp = allPitches.filter(p => p.pitcher_player_id === r.player_id);
      const strikes = pp.filter(p => ['called_strike','swinging_strike','foul','foul_tip','in_play'].includes(p.result)).length;
      const battersFaced = [...new Set(pp.map(p => p.at_bat_id))].length;
      const firstPitchStrikes = pp.filter(p => p.pitch_number_in_ab === 1 && p.result !== 'ball').length;
      const abIds = [...new Set(pp.map(p => p.at_bat_id))];
      const relevantABs = atBats.filter(ab => abIds.includes(ab.id) && ab.result);
      const walks = relevantABs.filter(ab => ab.result === 'BB' || ab.result === 'HBP').length;
      const ks = relevantABs.filter(ab => ab.result === 'K').length;
      const twoStrikeABs = relevantABs.filter(ab => ab.strikes_in_count >= 2 || ab.result === 'K').length;
      const hitInPlay = relevantABs.filter(ab => ab.hit_type);
      const groundBalls = hitInPlay.filter(ab => ab.hit_type === 'ground').length;
      const flyBalls = hitInPlay.filter(ab => ab.hit_type === 'fly').length;
      const hardContact = hitInPlay.filter(ab => ab.is_hard_contact).length;
      const stressPitches = pp.filter(p => {
        const ro = p.runners_on ? JSON.parse(p.runners_on) : {};
        const rISP = ro.second || ro.third;
        return rISP || p.pitch_number_in_ab >= 5;
      }).length;

      pitcherStats[r.player_id] = {
        pitchCount: cnt,
        strikePercent: cnt > 0 ? Math.round((strikes / cnt) * 100) : 0,
        firstPitchStrikePercent: battersFaced > 0 ? Math.round((firstPitchStrikes / battersFaced) * 100) : 0,
        bbHbp: walks,
        twoStrikePutAway: twoStrikeABs > 0 ? Math.round((ks / twoStrikeABs) * 100) : 0,
        gfRatio: flyBalls > 0 ? (groundBalls / flyBalls).toFixed(1) : groundBalls > 0 ? 'INF' : '-',
        hardContactPercent: hitInPlay.length > 0 ? Math.round((hardContact / hitInPlay.length) * 100) : 0,
        stressPitches,
        battersFaced,
      };
    }
  }

  const batterStats = {};
  for (const r of roster) {
    const playerABs = atBats.filter(ab => ab.batter_player_id === r.player_id && ab.result);
    const hits = playerABs.filter(ab => ['1B','2B','3B','HR'].includes(ab.result)).length;
    const abs = playerABs.filter(ab => !['BB','HBP','SAC'].includes(ab.result)).length;
    const rbis = playerABs.reduce((s, ab) => s + (ab.rbi_count || 0), 0);
    const ks = playerABs.filter(ab => ab.result === 'K').length;
    const bbs = playerABs.filter(ab => ab.result === 'BB' || ab.result === 'HBP').length;
    batterStats[r.player_id] = { hits, abs, rbis, ks, bbs, avg: abs > 0 ? (hits / abs).toFixed(3) : '-' };
  }

  const errors = atBats.filter(ab => ab.error_player_id).map(ab => ({
    player_id: ab.error_player_id,
    position: ab.error_position,
    inning: ab.inning,
  }));

  const inningScores = { us: {}, opp: {} };
  for (const ab of atBats) {
    if (ab.result && ab.rbi_count > 0) {
      const key = ab.is_our_team ? 'us' : 'opp';
      if (!inningScores[key][ab.inning]) inningScores[key][ab.inning] = 0;
      inningScores[key][ab.inning] += ab.rbi_count;
    }
  }

  res.json({ game, roster, oppRoster, batterStats, pitcherStats, pitchCounts, errors, inningScores });
});

app.get('/game/:id/stream', async (req, res) => {
  const game = await db.getLiveGame(Number(req.params.id));
  if (!game) return res.status(404).send('Game not found');
  res.render('game-stream', { game });
});

app.get('/api/game/:id/chat', async (req, res) => {
  const gameId = Number(req.params.id);
  const afterId = req.query.after ? Number(req.query.after) : null;
  const messages = await db.getGameChat(gameId, afterId);
  res.json(messages);
});

app.post('/api/game/:id/chat', async (req, res) => {
  const gameId = Number(req.params.id);
  const { author_name, message } = req.body;
  if (!author_name || !message) return res.status(400).json({ error: 'Name and message required' });
  const msg = await db.addGameChat({ game_id: gameId, author_name, message });
  res.json(msg);
});

app.get('/stats', async (req, res) => {
  const isAdmin = req.session && req.session.adminId;
  const isStaff = req.query.phone && await db.getStaffByPhone(normalizePhone(req.query.phone));
  const parentUser = req.parentUser;
  res.render('player-stats', { isAdmin: !!isAdmin, isStaff: !!isStaff, parentUser: parentUser || null });
});

app.get('/api/player-stats/:playerId', async (req, res) => {
  const playerId = Number(req.params.playerId);
  const isAdmin = req.session && req.session.adminId;
  const isStaff = req.query.phone && await db.getStaffByPhone(normalizePhone(req.query.phone));
  const parentUser = req.parentUser;

  if (!isAdmin && !isStaff) {
    if (!parentUser || !parentUser.player_ids.includes(playerId)) {
      return res.status(403).json({ error: 'Not authorized to view this player' });
    }
  }

  const player = await db.getPlayer(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const atBats = await db.getAtBatsForPlayer(playerId);
  const pitches = await db.getPitchesForPitcherSeason(playerId);

  const completed = atBats.filter(ab => ab.result);
  const hits = completed.filter(ab => ['1B','2B','3B','HR'].includes(ab.result)).length;
  const abs = completed.filter(ab => !['BB','HBP','SAC'].includes(ab.result)).length;
  const rbis = completed.reduce((s, ab) => s + (ab.rbi_count || 0), 0);
  const bbs = completed.filter(ab => ab.result === 'BB' || ab.result === 'HBP').length;
  const ks = completed.filter(ab => ab.result === 'K').length;
  const doubles = completed.filter(ab => ab.result === '2B').length;
  const triples = completed.filter(ab => ab.result === '3B').length;
  const hrs = completed.filter(ab => ab.result === 'HR').length;

  const batting = { hits, abs, avg: abs > 0 ? (hits / abs).toFixed(3) : '-', rbis, bbs, ks, doubles, triples, hrs, pa: completed.length };
  const pitching = { totalPitches: pitches.length };

  if (pitches.length > 0) {
    const strikes = pitches.filter(p => ['called_strike','swinging_strike','foul','foul_tip','in_play'].includes(p.result)).length;
    pitching.strikePercent = Math.round((strikes / pitches.length) * 100);
    const gameGroups = {};
    for (const p of pitches) { if (!gameGroups[p.game_id]) gameGroups[p.game_id] = []; gameGroups[p.game_id].push(p); }
    pitching.games = Object.keys(gameGroups).length;
  }

  res.json({ player: { id: player.id, player_name: player.player_name, jersey_number: player.jersey_number }, batting, pitching });
});

app.get('/api/team-stats', async (req, res) => {
  const isAdmin = req.session && req.session.adminId;
  const isStaff = req.query.phone && await db.getStaffByPhone(normalizePhone(req.query.phone));
  if (!isAdmin && !isStaff) return res.status(403).json({ error: 'Admin or staff only' });

  const players = (await db.getAllPlayers()).filter(p => p.status === 'confirmed');
  const stats = [];
  for (const p of players) {
    const atBats = await db.getAtBatsForPlayer(p.id);
    const completed = atBats.filter(ab => ab.result);
    const hits = completed.filter(ab => ['1B','2B','3B','HR'].includes(ab.result)).length;
    const abs = completed.filter(ab => !['BB','HBP','SAC'].includes(ab.result)).length;
    const rbis = completed.reduce((s, ab) => s + (ab.rbi_count || 0), 0);
    stats.push({ player_id: p.id, player_name: p.player_name, jersey_number: p.jersey_number, hits, abs, avg: abs > 0 ? (hits / abs).toFixed(3) : '-', rbis, pa: completed.length });
  }
  res.json(stats);
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
    console.log(`Team portal running at http://localhost:${PORT}`);
  });
  setInterval(checkAndSendReminders, 15 * 60 * 1000);
  setTimeout(checkAndSendReminders, 15000);
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
