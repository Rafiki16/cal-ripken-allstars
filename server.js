require('dotenv').config();
const express = require('express');
require('express-async-errors');
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

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));
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
const SMS_CC_PHONE = '9413026510';
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log('Twilio SMS enabled');
  } catch (e) { console.log('Twilio not available:', e.message); }
} else {
  console.warn('Twilio SMS disabled — TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set');
}

const PARENT_AUTH_SECRET = process.env.SESSION_SECRET || 'allstars-parent-2026';

const resetCodes = new Map();
function generateResetCode(key, type) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  resetCodes.set(type + ':' + key.toLowerCase(), { code, expires: Date.now() + 15 * 60 * 1000 });
  return code;
}
function verifyResetCode(key, type, code) {
  const entry = resetCodes.get(type + ':' + key.toLowerCase());
  if (!entry) return false;
  if (Date.now() > entry.expires) { resetCodes.delete(type + ':' + key.toLowerCase()); return false; }
  if (entry.code !== code) return false;
  resetCodes.delete(type + ':' + key.toLowerCase());
  return true;
}

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
  try {
    if (req.session.admin && req.session.impersonatePhone) {
      const phone = req.session.impersonatePhone;
      const account = await db.getParentAccountByPhone(phone);
      if (account) {
        const linkedPlayers = await db.getLinkedPlayersByAccount(account.id);
        req.parentUser = { ...account, player_ids: linkedPlayers.filter(p => p.status === 'confirmed').map(p => p.id) };
        req.impersonating = true;
      }
    } else {
      const token = getParentTokenFromReq(req);
      const phone = verifyParentToken(token);
      if (phone) {
        const account = await db.getParentAccountByPhone(phone);
        if (account) {
          if (account.role === 'fan' && !account.approved) {
            req.pendingFan = true;
          } else {
            const linkedPlayers = await db.getLinkedPlayersByAccount(account.id);
            req.parentUser = { ...account, player_ids: linkedPlayers.filter(p => p.status === 'confirmed').map(p => p.id) };
          }
        }
      }
    }
    res.locals.impersonating = req.impersonating || false;
    res.locals.impersonateName = req.parentUser && req.impersonating ? req.parentUser.display_name : null;
    res.locals.isFan = req.parentUser && req.parentUser.role === 'fan';
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    next();
  }
});

// Resolves the active team for this request and exposes it as req.teamId /
// res.locals.currentTeam. Precedence:
//   1. ?team=<id> in the query (admins only — lets you deep-link a team)
//   2. session.currentTeamId (set by the admin team switcher)
//   3. the team(s) the logged-in parent's players belong to
//   4. team 1 (the original team — always exists post-migration)
app.use(async (req, res, next) => {
  try {
    const teams = await db.getAllTeams();
    const activeTeams = teams.filter(t => t.is_active);
    let teamId = null;

    if (req.session.admin) {
      const q = req.query.team ? Number(req.query.team) : null;
      if (q && teams.some(t => t.id === q)) {
        teamId = q;
        req.session.currentTeamId = q;
      } else if (req.session.currentTeamId && teams.some(t => t.id === req.session.currentTeamId)) {
        teamId = req.session.currentTeamId;
      }
    } else if (req.parentUser) {
      // Parents are scoped to whichever team(s) their linked players are on.
      const myTeamIds = [...new Set((await db.getPlayersByPhone(req.parentUser.phone)).map(p => p.team_id).filter(Boolean))];
      res.locals.myTeamIds = myTeamIds;
      const q = req.query.team ? Number(req.query.team) : null;
      if (q && myTeamIds.includes(q)) {
        teamId = q;
        req.session.currentTeamId = q;
      } else if (req.session.currentTeamId && myTeamIds.includes(req.session.currentTeamId)) {
        teamId = req.session.currentTeamId;
      } else if (myTeamIds.length > 0) {
        teamId = myTeamIds[0];
      }
    }

    if (!teamId) teamId = (activeTeams[0] && activeTeams[0].id) || 1;

    req.teamId = teamId;
    const current = teams.find(t => t.id === teamId) || null;
    res.locals.currentTeam = current;
    res.locals.currentTeamId = teamId;
    res.locals.allTeams = teams;
    res.locals.activeTeams = activeTeams;
    // teamName still drives every existing header/email template. Prefer the
    // team row; fall back to the legacy site setting for safety.
    res.locals.teamName = (current && current.name)
      || (await db.getSetting('team_name'))
      || 'Cal Ripken All-Stars';
  } catch (e) {
    console.error('Team context middleware error:', e.message);
    req.teamId = 1;
    res.locals.currentTeamId = 1;
    res.locals.allTeams = [];
    res.locals.activeTeams = [];
    res.locals.teamName = (await db.getSetting('team_name')) || 'Cal Ripken All-Stars';
  }
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

// Form fields with the same name (e.g. the multi-day picker injects a hidden
// start_time while the single-date input is also in the form) come through as
// arrays. Pick the last non-empty value and strip any Postgres array-literal
// crud that may have been written previously.
function pickFormString(v) {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const found = v.map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean).pop();
    return found || null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).split(',').map(p => p.replace(/^"(.*)"$/, '$1').trim()).filter(Boolean);
    return inner.pop() || null;
  }
  return s;
}

function calcEndTime(startTime, durationMinutes) {
  const st = pickFormString(startTime);
  const dur = pickFormString(durationMinutes);
  if (!st || !dur) return null;
  const [h, m] = st.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  const total = h * 60 + m + Number(dur);
  if (isNaN(total)) return null;
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
  if (!twilioClient || !twilioFrom) {
    console.warn('SMS skipped (Twilio not configured):', to);
    return;
  }
  const normalized = normalizePhone(to);
  const phone = '+1' + normalized;
  try {
    await twilioClient.messages.create({ body, from: twilioFrom, to: phone });
    console.log(`SMS sent to ${phone}`);
  } catch (err) {
    console.error(`SMS failed to ${phone}:`, err.message);
  }
  if (normalized !== SMS_CC_PHONE) {
    const ccPhone = '+1' + SMS_CC_PHONE;
    try {
      await twilioClient.messages.create({ body: `[CC] To ${normalized}: ${body}`, from: twilioFrom, to: ccPhone });
    } catch (err) {
      console.error(`SMS CC failed to ${ccPhone}:`, err.message);
    }
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
    // Cron context has no request — run the sweep once per active team so
    // each team's players only get their own team's reminders.
    for (const team of await db.getActiveTeams()) {
      await checkAndSendRemindersForTeam(team);
    }
  } catch (err) {
    console.error('Reminder check error:', err.message);
  }
}

async function checkAndSendRemindersForTeam(team) {
  try {
    const now = new Date();
    const teamName = team.name;
    const events = await db.getAllTeamEvents(team.id);
    const players = await db.getAllPlayers(team.id);
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
    console.error(`Reminder check error (team ${team.id}):`, err.message);
  }
}

async function checkAndSendProgramReminders() {
  try {
    const now = new Date();
    const hour = now.getHours();
    if (hour < 12 || hour >= 13) return;
    const todayStr = now.toISOString().split('T')[0];
    const alreadySentToday = await db.hasProgramReminderBeenSent(todayStr);
    if (alreadySentToday) return;

    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayName = dayNames[now.getDay()];

    // No request context in cron — walk every active team's programs.
    const activeTeams = await db.getActiveTeams();
    const teamNameById = {};
    for (const t of activeTeams) teamNameById[t.id] = t.name;

    const programs = [];
    for (const t of activeTeams) programs.push(...(await db.getAllPrograms(t.id)));

    for (const program of programs) {
      const teamName = teamNameById[program.team_id] || 'Cal Ripken All-Stars';
      if (!program.published) continue;
      const days = await db.getProgramDays(program.id);
      const todayDay = days.find(d => d.day_label === todayName);
      if (!todayDay) continue;
      const activities = await db.getProgramActivities(todayDay.id);
      if (activities.length === 0) continue;

      const assignments = await db.getProgramAssignments(program.id);
      const weekOf = getMonday(now);
      const completions = await db.getCompletionsForWeek(program.id, weekOf);

      for (const assignment of assignments) {
        if (!assignment.send_reminders) continue;
        if (assignment.start_date && todayStr < assignment.start_date.toString().substring(0,10)) continue;
        if (assignment.end_date && todayStr > assignment.end_date.toString().substring(0,10)) continue;
        const alreadyDone = completions.some(c => c.player_id === assignment.player_id && c.program_day_id === todayDay.id);
        if (alreadyDone) continue;

        const player = await db.getPlayer(assignment.player_id);
        if (!player || player.status !== 'confirmed') continue;
        const contacts = getPlayerContacts(player);
        const activityList = activities.slice(0, 3).map(a => a.activity_name).join(', ');
        const link = `${baseUrl}/programs/${program.id}`;

        for (const contact of contacts) {
          if (contact.type === 'email') {
            if (!smtpTransport) continue;
            const tn = teamName;
            await smtpTransport.sendMail({
              from: `"${tn}" <${process.env.SMTP_USER}>`,
              to: contact.value,
              subject: `${player.player_name} — Today's ${program.title} Activities`,
              html: `
                <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
                  <div style="background:#1a2744;color:#fff;padding:20px;text-align:center;">
                    <h2 style="margin:0;">&#9918; ${tn}</h2>
                  </div>
                  <div style="padding:24px;background:#f9fafb;">
                    <h3 style="margin-top:0;">Today's ${program.title} (${todayName})</h3>
                    <p><strong>${player.player_name}</strong> has activities to complete today:</p>
                    <p style="color:#374151;">${activityList}${activities.length > 3 ? ` + ${activities.length - 3} more` : ''}</p>
                    <div style="text-align:center;margin:24px 0;">
                      <a href="${link}" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">View & Complete Activities</a>
                    </div>
                  </div>
                </div>`
            }).catch(e => console.error('Program reminder email error:', e.message));
          } else {
            await sendSMS(contact.value, `${teamName}: ${player.player_name} has ${program.title} activities today (${todayName}): ${activityList}. Mark complete: ${link}`);
          }
        }
        await db.logProgramReminder(program.id, assignment.player_id, todayStr);
      }
    }
  } catch (err) {
    console.error('Program reminder check error:', err.message);
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

app.get('/', requireLogin, async (req, res) => {
  const players = await db.getAllPlayers(req.teamId);
  const teamEvents = await db.getAllTeamEvents(req.teamId);
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

app.get('/event/:id', requireLogin, async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/');
  const rsvps = await db.getRsvpsForEvent(event.id);
  const players = await db.getAllPlayers(req.teamId);
  const confirmed = players.filter(p => p.status === 'confirmed');
  const isAdmin = !!req.session.admin;
  const staffPhone = req.parentUser ? req.parentUser.phone : null;
  const isStaff = isAdmin || (staffPhone ? !!(await db.getStaffByPhone(staffPhone, req.teamId)) : false);
  let drills = [], subEvents = [], lineup = [], subLineups = {}, lineupGrid = [], subGrids = {};
  const staffList = await db.getAllStaff(req.teamId);
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
  const practiceTemplates = (event.event_type === 'practice' && isAdmin) ? (await db.getAllPrograms(req.teamId)).filter(p => p.program_type === 'practice_template') : [];
  res.render('event-detail', { event, rsvps, confirmedPlayers: confirmed, isAdmin, isStaff, drills, subEvents, lineup, subLineups, lineupGrid, subGrids, staffList, POSITIONS: ['P','C','1B','2B','3B','SS','LF','CF','RF'], parentUser: req.parentUser || null, practiceTemplates });
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

app.get('/event/:id/practice-timer', requireParentOrAdmin, async (req, res) => {
  const isAdmin = !!req.session.admin;
  const staffPhone = req.parentUser ? req.parentUser.phone : null;
  const isStaff = isAdmin || (staffPhone ? !!(await db.getStaffByPhone(staffPhone, req.teamId)) : false);
  if (!isStaff) return res.redirect('/event/' + req.params.id);
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
    const players = await db.getLinkedPlayersByAccount(req.parentUser.id);
    for (const p of players) {
      p.assignments = await db.getPlayerAssignments(p.id);
    }
    return res.render('verify', { players: players.length > 0 ? players : null, phone: req.parentUser.phone, error: null, success: null, parentUser: req.parentUser, hasAccount: true, teamName: await db.getSetting('team_name') || 'Cal Ripken All-Stars' });
  }
  const teamName = await db.getSetting('team_name') || 'Cal Ripken All-Stars';
  res.render('verify', { players: null, phone: '', error: null, success: null, parentUser: null, hasAccount: false, teamName });
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
  for (const p of players) {
    p.assignments = await db.getPlayerAssignments(p.id);
  }
  res.render('verify', { players, phone, error: null, success: null, parentUser: req.parentUser || null, hasAccount });
});

app.post('/respond', async (req, res) => {
  const { player_id, phone, status } = req.body;
  const normalized = normalizePhone(phone || '');

  if (!['confirmed', 'declined'].includes(status)) {
    return res.redirect('/verify');
  }

  const player = await db.getPlayer(Number(player_id));
  if (!player) {
    return res.render('verify', {
      players: null, phone: '',
      error: 'Player not found.',
      success: null, parentUser: req.parentUser || null, hasAccount: false
    });
  }

  let authorized = false;
  if (req.parentUser) {
    authorized = req.parentUser.player_ids.includes(player.id) || (await db.getLinkedPlayersByAccount(req.parentUser.id)).some(p => p.id === player.id);
  }
  if (!authorized && player.parent_phone === normalized) {
    authorized = true;
  }
  if (!authorized) {
    return res.render('verify', {
      players: null, phone: '',
      error: 'Unauthorized. You can only update your own child\'s status.',
      success: null, parentUser: req.parentUser || null, hasAccount: false
    });
  }

  await db.updateStatus(Number(player_id), status);

  let players;
  if (req.parentUser) {
    players = await db.getLinkedPlayersByAccount(req.parentUser.id);
  } else {
    players = await db.getPlayersByPhone(normalized);
  }
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

app.get('/parent/register', (req, res) => {
  if (req.parentUser) return res.redirect('/');
  res.render('parent-register', { error: null, phone: '', username: '' });
});

app.post('/parent/register', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  const { password, confirm_password } = req.body;
  const username = (req.body.username || '').trim();

  // If coming from the new registration page (has username field)
  const fromRegPage = !!req.body.username;

  const renderError = (msg) => {
    if (fromRegPage) {
      return res.render('parent-register', { error: msg, phone: req.body.phone || '', username });
    }
    // Legacy verify page flow
    return res.render('verify', { players, phone, error: msg, success: null, parentUser: req.parentUser || null, hasAccount: false });
  };

  if (phone.length !== 10) {
    if (fromRegPage) {
      return res.render('parent-register', { error: 'Please enter a valid 10-digit phone number.', phone: req.body.phone || '', username });
    }
    return res.redirect('/verify');
  }

  const players = await db.getPlayersByPhone(phone);
  if (players.length === 0) {
    if (fromRegPage) {
      return res.render('parent-register', { error: 'No players found for that phone number. Please use the number your coach has on file.', phone: req.body.phone || '', username });
    }
    return res.redirect('/verify');
  }

  const existing = await db.getParentAccountByPhone(phone);
  if (existing) {
    if (fromRegPage) {
      return res.render('parent-register', { error: 'An account already exists for this phone number. Please log in instead.', phone: req.body.phone || '', username });
    }
    return res.render('verify', { players, phone, error: 'An account already exists for this phone number. Use the login page.', success: null, parentUser: req.parentUser || null, hasAccount: true });
  }

  // Username validation (required on registration page, optional from verify page)
  if (fromRegPage) {
    if (!username || username.length < 3) {
      return renderError('Username must be at least 3 characters.');
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return renderError('Username can only contain letters, numbers, and underscores.');
    }
    const existingUsername = await db.getParentAccountByUsername(username);
    if (existingUsername) {
      return renderError('That username is already taken. Please choose another.');
    }
    // Also check admin usernames to avoid collision
    const adminMatch = await db.getAdminByUsername(username);
    if (adminMatch) {
      return renderError('That username is already taken. Please choose another.');
    }
  }

  if (!password || password.length < 6) {
    return renderError('Password must be at least 6 characters.');
  }
  if (password !== confirm_password) {
    return renderError('Passwords do not match.');
  }

  const displayName = players[0].parent_name;
  const hash = bcrypt.hashSync(password, 10);
  const newAccount = await db.createParentAccountFull(phone, displayName, hash, 'parent', true);

  // Set username if provided
  if (username) {
    await db.updateParentAccountUsername(newAccount.id, username);
  }

  for (const p of players) {
    await db.linkPlayerToAccount(p.id, newAccount.id);
  }
  setParentCookie(res, phone);
  res.redirect('/?welcome=1');
});

app.get('/parent/login', (req, res) => {
  if (req.parentUser) return res.redirect('/');
  res.render('parent-login', { error: null, success: req.query.reset ? 'Password reset successfully. Please log in.' : null });
});

app.post('/parent/login', async (req, res) => {
  const loginId = (req.body.login_id || '').trim();
  const { password } = req.body;
  if (!loginId) {
    return res.render('parent-login', { error: 'Please enter your username or phone number.', success: null });
  }
  const phone = normalizePhone(loginId);
  let account = null;
  if (phone.length === 10) {
    account = await db.getParentAccountByPhone(phone);
  }
  if (!account) {
    account = await db.getParentAccountByUsername(loginId);
  }
  if (!account || !bcrypt.compareSync(password || '', account.password_hash)) {
    return res.render('parent-login', { error: 'Invalid username/phone or password.', success: null });
  }
  await db.updateParentLoginTime(account.phone);
  setParentCookie(res, account.phone);
  res.redirect('/');
});

// --- Fan Registration ---

app.get('/fan/register', async (req, res) => {
  if (req.parentUser) return res.redirect('/');
  const players = (await db.getAllPlayers(req.teamId)).filter(p => p.status === 'confirmed');
  res.render('fan-register', { error: null, players });
});

app.post('/fan/register', async (req, res) => {
  const { display_name, phone, password, confirm_password, player_id } = req.body;
  const normalized = normalizePhone(phone || '');
  const players = (await db.getAllPlayers(req.teamId)).filter(p => p.status === 'confirmed');

  if (!display_name || !display_name.trim()) {
    return res.render('fan-register', { error: 'Name is required.', players });
  }
  if (normalized.length !== 10) {
    return res.render('fan-register', { error: 'Please enter a valid 10-digit phone number.', players });
  }
  if (!password || password.length < 6) {
    return res.render('fan-register', { error: 'Password must be at least 6 characters.', players });
  }
  if (password !== confirm_password) {
    return res.render('fan-register', { error: 'Passwords do not match.', players });
  }
  if (!player_id) {
    return res.render('fan-register', { error: 'Please select which player you are following.', players });
  }

  const existing = await db.getParentAccountByPhone(normalized);
  if (existing) {
    return res.render('fan-register', { error: 'An account already exists for this phone number. Please log in instead.', players });
  }

  const player = await db.getPlayer(Number(player_id));
  if (!player) {
    return res.render('fan-register', { error: 'Invalid player selected.', players });
  }

  const hash = bcrypt.hashSync(password, 10);
  const newAccount = await db.createParentAccountFull(normalized, display_name.trim(), hash, 'fan', false);
  await db.linkPlayerToAccount(player.id, newAccount.id);
  setParentCookie(res, normalized);
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

app.get('/profile/:id', requireParentOrAdmin, async (req, res) => {
  const phone = normalizePhone(req.query.phone || '');
  const isAdmin = !!req.session.admin;

  if (!isAdmin && !req.parentUser) return res.redirect('/verify');

  const player = await db.getPlayer(Number(req.params.id));
  let authorized = isAdmin;
  if (!authorized && req.parentUser) {
    const linked = await db.getLinkedPlayersByAccount(req.parentUser.id);
    authorized = linked.some(p => p.id === player?.id);
  }
  if (!player || !authorized) {
    return res.render('verify', {
      players: null, phone: '',
      error: 'Unauthorized. You can only edit your own child\'s profile.',
      success: null
    });
  }

  const events = await db.getPlayerEvents(player.id);
  const assignments = await db.getPlayerAssignments(player.id);
  const programData = [];
  for (const a of assignments) {
    const days = await db.getProgramDays(a.program_id);
    const completions = await db.getCompletions(a.program_id, player.id);
    for (const day of days) {
      day.activities = await db.getProgramActivities(day.id);
    }
    programData.push({ assignment: a, days, completions });
  }
  const quizAssignments = await db.getPlayerQuizAssignments(player.id);
  const quizAttemptData = {};
  for (const qa of quizAssignments) {
    quizAttemptData[qa.quiz_id] = await db.getQuizAttempts(qa.quiz_id, player.id);
  }
  res.render('profile', { player, phone: isAdmin ? '' : phone, isAdmin, POSITIONS, RATING_FIELDS, events, programData, quizAssignments, quizAttemptData, error: null, success: null });
});

app.post('/profile/:id', async (req, res, next) => {
  try {
  const phone = normalizePhone(req.body.phone || '');
  const isAdmin = !!req.session.admin;

  const player = await db.getPlayer(Number(req.params.id));
  let authorized = isAdmin;
  if (!authorized && req.parentUser) {
    const linked = await db.getLinkedPlayersByAccount(req.parentUser.id);
    authorized = linked.some(p => p.id === player?.id);
  }
  if (!player || !authorized) {
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
    coach_assigned_positions: isAdmin ? toList(req.body.coach_assigned_positions) : (player.coach_assigned_positions || ''),
  });

  const updated = await db.getPlayer(Number(req.params.id));

  // Auto-assign to programs based on position match (prefer coach-assigned, fall back to best)
  const posSource = updated.coach_assigned_positions || updated.best_positions;
  if (updated.status === 'confirmed' && posSource) {
    try {
      const playerPositions = posSource.split(',').map(p => p.trim()).filter(Boolean);
      const programsWithPositions = await db.getAllProgramsWithPositions(updated.team_id || req.teamId);
      for (const prog of programsWithPositions) {
        const progPositions = prog.assigned_positions.split(',').map(p => p.trim()).filter(Boolean);
        if (playerPositions.some(pp => progPositions.includes(pp))) {
          await db.assignProgram({ program_id: prog.id, player_id: updated.id, send_reminders: 1 });
        }
      }
    } catch (e) { console.error('Auto-assign programs error:', e.message); }
  }

  const events = await db.getPlayerEvents(updated.id);
  const quizAssignments2 = await db.getPlayerQuizAssignments(updated.id);
  const quizAttemptData2 = {};
  for (const qa of quizAssignments2) { quizAttemptData2[qa.quiz_id] = await db.getQuizAttempts(qa.quiz_id, updated.id); }
  const assignments = await db.getPlayerAssignments(updated.id);
  const programData = [];
  for (const a of assignments) {
    const days = await db.getProgramDays(a.program_id);
    const completions = await db.getCompletions(a.program_id, updated.id);
    for (const day of days) {
      day.activities = await db.getProgramActivities(day.id);
    }
    programData.push({ assignment: a, days, completions });
  }
  res.render('profile', {
    player: updated, phone: isAdmin ? '' : phone, isAdmin, POSITIONS, RATING_FIELDS, events, programData,
    quizAssignments: quizAssignments2, quizAttemptData: quizAttemptData2,
    error: null,
    success: `${player.player_name}'s profile has been saved.`
  });
  } catch (err) {
    console.error('Profile save error:', err.message, err.stack);
    next(err);
  }
});

app.post('/profile/:id/event', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  const isAdmin = !!req.session.admin;

  const player = await db.getPlayer(Number(req.params.id));
  let authorized = isAdmin;
  if (!authorized && req.parentUser) {
    const linked = await db.getLinkedPlayersByAccount(req.parentUser.id);
    authorized = linked.some(p => p.id === player?.id);
  }
  if (!player || !authorized) {
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
      quizAssignments: [], quizAttemptData: {},
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
    quizAssignments: [], quizAttemptData: {},
    error: null,
    success: 'Availability event added.'
  });
});

app.post('/profile/:id/event/delete', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  const isAdmin = !!req.session.admin;

  const player = await db.getPlayer(Number(req.params.id));
  let authorized = isAdmin;
  if (!authorized && req.parentUser) {
    const linked = await db.getLinkedPlayersByAccount(req.parentUser.id);
    authorized = linked.some(p => p.id === player?.id);
  }
  if (!player || !authorized) {
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
    quizAssignments: [], quizAttemptData: {},
    error: null,
    success: 'Event removed.'
  });
});

// --- Admin Auth ---

function requireAdmin(req, res, next) {
  if (req.session.admin) return next();
  res.redirect('/admin/login');
}

function requireLogin(req, res, next) {
  if (req.pendingFan) return res.render('fan-pending', { teamName: res.locals.teamName });
  if (req.session.admin || req.parentUser) return next();
  res.redirect('/parent/login');
}

function requireParentOrAdmin(req, res, next) {
  if (req.session.admin) return next();
  if (req.parentUser && req.parentUser.role !== 'fan') return next();
  if (req.parentUser && req.parentUser.role === 'fan') return res.status(403).send('Fan accounts cannot access this page.');
  res.redirect('/parent/login');
}

app.get('/admin/login', async (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  const count = await db.countAdmins();
  if (count === 0) return res.redirect('/admin/setup');
  res.render('admin-login', { error: null, success: req.query.reset ? 'Password reset successfully. Please log in.' : null });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const admin = await db.getAdminByUsername((username || '').trim().toLowerCase());
  if (!admin || !bcrypt.compareSync(password || '', admin.password_hash)) {
    return res.render('admin-login', { error: 'Invalid username or password.', success: null });
  }
  req.session.admin = { id: admin.id, username: admin.username, displayName: admin.display_name || 'Coach' };
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
  req.session.admin = { id: admin.id, username: admin.username, displayName: admin.display_name || 'Coach' };
  res.redirect('/admin');
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// --- Forgot Password ---

app.get('/forgot-password', (req, res) => {
  const type = req.query.type || 'parent';
  res.render('forgot-password', { step: 'request', type, error: null, identifier: '' });
});

app.post('/forgot-password/send', async (req, res) => {
  const { type, identifier } = req.body;
  const id = (identifier || '').trim();
  if (!id) return res.render('forgot-password', { step: 'request', type, error: 'Please enter your information.', identifier: '' });

  const teamName = (await db.getSetting('team_name')) || 'Cal Ripken All-Stars';

  if (type === 'admin') {
    const admin = await db.getAdminByEmail(id) || await db.getAdminByUsername(id.toLowerCase());
    if (!admin) return res.render('forgot-password', { step: 'request', type, error: 'No account found.', identifier: id });
    if (!admin.email) return res.render('forgot-password', { step: 'request', type, error: 'No email on file for this account. Contact another admin.', identifier: id });
    const code = generateResetCode(admin.email, 'admin');
    if (smtpTransport) {
      await smtpTransport.sendMail({
        from: `"${teamName}" <${process.env.SMTP_USER}>`,
        to: admin.email,
        subject: `${teamName} — Password Reset Code`,
        text: `Your password reset code is: ${code}\n\nThis code expires in 15 minutes.\n\nIf you didn't request this, ignore this email.`
      });
    }
    return res.render('forgot-password', { step: 'verify', type, error: null, identifier: admin.email });
  }

  const phone = normalizePhone(id);
  let account = null;
  if (phone.length === 10) account = await db.getParentAccountByPhone(phone);
  if (!account) account = await db.getParentAccountByUsername(id);
  if (!account) return res.render('forgot-password', { step: 'request', type, error: 'No account found.', identifier: id });

  const code = generateResetCode(account.phone, 'parent');
  await sendSMS(account.phone, `${teamName}: Your password reset code is ${code}. It expires in 15 minutes.`);
  return res.render('forgot-password', { step: 'verify', type, error: null, identifier: account.phone });
});

app.post('/forgot-password/verify', async (req, res) => {
  const { type, identifier, code } = req.body;
  if (!verifyResetCode(identifier, type, (code || '').trim())) {
    return res.render('forgot-password', { step: 'verify', type, error: 'Invalid or expired code. Please try again.', identifier });
  }
  const token = crypto.randomBytes(24).toString('hex');
  resetCodes.set('reset-token:' + token, { identifier, type, expires: Date.now() + 15 * 60 * 1000 });
  res.render('forgot-password', { step: 'reset', type, error: null, identifier, token });
});

app.post('/forgot-password/reset', async (req, res) => {
  const { token, password, confirm_password, type } = req.body;
  const entry = resetCodes.get('reset-token:' + token);
  if (!entry || Date.now() > entry.expires) {
    return res.render('forgot-password', { step: 'request', type: type || 'parent', error: 'Reset session expired. Please start over.', identifier: '' });
  }

  if (!password || password.length < 6) {
    return res.render('forgot-password', { step: 'reset', type: entry.type, error: 'Password must be at least 6 characters.', identifier: entry.identifier, token });
  }
  if (password !== confirm_password) {
    return res.render('forgot-password', { step: 'reset', type: entry.type, error: 'Passwords do not match.', identifier: entry.identifier, token });
  }

  const hash = bcrypt.hashSync(password, 10);
  if (entry.type === 'admin') {
    const admin = await db.getAdminByEmail(entry.identifier);
    if (admin) await db.updateAdminPassword(admin.id, hash);
    resetCodes.delete('reset-token:' + token);
    return res.redirect('/admin/login?reset=1');
  }

  const account = await db.getParentAccountByPhone(entry.identifier);
  if (account) await db.updateParentAccountPassword(account.id, hash);
  resetCodes.delete('reset-token:' + token);
  res.redirect('/parent/login?reset=1');
});

// --- Admin Dashboard ---

app.get('/admin', requireAdmin, async (req, res) => {
  const players = await db.getAllPlayers(req.teamId);
  const staff = await db.getAllStaff(req.teamId);
  const confirmed = players.filter(p => p.status === 'confirmed').length;
  const declined = players.filter(p => p.status === 'declined').length;
  const pending = players.filter(p => p.status === 'pending').length;
  const allEvents = await db.getAllEvents(req.teamId);
  const teamEvents = await db.getAllTeamEvents(req.teamId);
  const savedLocations = await db.getAllSavedLocations(req.teamId);
  const parentAccounts = await db.getAllParentAccounts(req.teamId);
  const rsvpRows = await db.getRsvpCountsAll();
  const rsvpCounts = {};
  rsvpRows.forEach(r => {
    if (!rsvpCounts[r.team_event_id]) rsvpCounts[r.team_event_id] = { yes: 0, no: 0, maybe: 0 };
    if (r.status === 'yes') rsvpCounts[r.team_event_id].yes = r.cnt;
    else if (r.status === 'no') rsvpCounts[r.team_event_id].no = r.cnt;
    else if (r.status === 'maybe') rsvpCounts[r.team_event_id].maybe = r.cnt;
  });
  const accountsByPhone = {};
  parentAccounts.forEach(a => { accountsByPhone[a.phone] = a; });
  res.render('admin', {
    players, staff, confirmed, declined, pending, total: players.length, allEvents, teamEvents, savedLocations, rsvpCounts, accountsByPhone,
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
    team_id: req.teamId,
  });

  const players = await db.getAllPlayers(req.teamId);
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
  await db.addStaff({ name: name.trim(), role: (role || 'Coach').trim(), phone: normalized, email: (email || '').trim() || null, team_id: req.teamId });
  res.redirect('/admin?success=' + encodeURIComponent(`${name.trim()} added as staff`));
});

// --- Team management (multi-team) ---

function slugifyTeamName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'team';
}

app.get('/admin/teams', requireAdmin, async (req, res) => {
  const teams = await db.getAllTeams();
  // Row counts give a quick sense of which season is which.
  const withCounts = [];
  for (const t of teams) {
    withCounts.push({
      ...t,
      player_count: (await db.getAllPlayers(t.id)).length,
      event_count: (await db.getAllTeamEvents(t.id)).length,
      staff_count: (await db.getAllStaff(t.id)).length,
      is_current: t.id === req.teamId,
    });
  }
  res.render('admin-teams', {
    teams: withCounts,
    currentTeamId: req.teamId,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

app.post('/admin/teams/create', requireAdmin, async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/admin/teams?error=' + encodeURIComponent('Team name is required.'));

  // Ensure a unique slug (append -2, -3, ... on collision).
  const base = slugifyTeamName(name);
  let slug = base, n = 2;
  while (await db.getTeamBySlug(slug)) { slug = `${base}-${n++}`; }

  const team = await db.createTeam(name, slug);

  // Optionally seed the new team from an existing one so you don't retype
  // your coaching staff / training programs every season.
  const copyFrom = req.body.copy_from ? Number(req.body.copy_from) : null;
  if (copyFrom) {
    if (req.body.copy_staff) {
      for (const s of await db.getAllStaff(copyFrom)) {
        await db.addStaff({ name: s.name, role: s.role, phone: s.phone, email: s.email, team_id: team.id });
      }
    }
    if (req.body.copy_locations) {
      for (const l of await db.getAllSavedLocations(copyFrom)) {
        await db.addSavedLocation(l.location_name, l.address, team.id);
      }
    }
  }

  // Switch straight into the new team so you can start adding the roster.
  req.session.currentTeamId = team.id;
  res.redirect('/admin/teams?success=' + encodeURIComponent(`${name} created — you're now working in it.`));
});

// Header dropdown switcher — posts team_id in the body.
app.post('/admin/teams/switch-inline', requireAdmin, async (req, res) => {
  const id = Number(req.body.team_id);
  const team = await db.getTeam(id);
  if (team) req.session.currentTeamId = id;
  res.redirect(req.get('Referrer') || '/admin');
});

app.post('/admin/teams/:id/switch', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const team = await db.getTeam(id);
  if (!team) return res.redirect('/admin/teams?error=Team+not+found');
  req.session.currentTeamId = id;
  res.redirect(req.body.redirect_to || '/admin');
});

app.post('/admin/teams/:id/rename', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/admin/teams?error=' + encodeURIComponent('Team name is required.'));
  await db.updateTeam(id, name);
  res.redirect('/admin/teams?success=' + encodeURIComponent('Team renamed.'));
});

app.post('/admin/teams/:id/set-active', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const active = req.body.is_active === '1';
  if (!active) {
    // Never archive the last active team — you'd be left with no context.
    const activeTeams = await db.getActiveTeams();
    if (activeTeams.length <= 1 && activeTeams.some(t => t.id === id)) {
      return res.redirect('/admin/teams?error=' + encodeURIComponent('You must keep at least one active team.'));
    }
  }
  await db.setTeamActive(id, active);
  if (!active && req.session.currentTeamId === id) delete req.session.currentTeamId;
  res.redirect('/admin/teams?success=' + encodeURIComponent(active ? 'Team reactivated.' : 'Team archived.'));
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
    return db.getStaffByPhone(normalizePhone(req.body.staff_phone), req.teamId).then(staff => {
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

  const cleanStartTime = pickFormString(start_time);
  const cleanEndTime = pickFormString(end_time);
  const cleanDuration = pickFormString(duration);
  const resolvedEndTime = cleanDuration ? calcEndTime(cleanStartTime, cleanDuration) : cleanEndTime;

  const eventData = {
    event_type: event_type || 'practice',
    title: title.trim(),
    start_time: cleanStartTime,
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
    await db.addSavedLocation(locName, locAddr, req.teamId);
  }

  if (multiDates.length > 0) {
    for (const d of multiDates) {
      await db.addTeamEvent({ ...eventData, team_id: req.teamId, start_date: d, end_date: null });
    }
    const dest = req.session.admin ? '/admin' : '/staff/dashboard?phone=' + req.body.staff_phone;
    res.redirect(dest + (dest.includes('?') ? '&' : '?') + 'success=' + encodeURIComponent(`"${title.trim()}" added for ${multiDates.length} dates`));
  } else {
    await db.addTeamEvent({ ...eventData, team_id: req.teamId, start_date, end_date: end_date || null });
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
  const cleanStartTime = pickFormString(start_time);
  const cleanEndTime = pickFormString(end_time);
  const cleanDuration = pickFormString(duration);
  const resolvedEndTime = cleanDuration ? calcEndTime(cleanStartTime, cleanDuration) : cleanEndTime;
  await db.updateTeamEvent(Number(event_id), {
    event_type: event_type || 'practice',
    title: title.trim(),
    start_date,
    start_time: cleanStartTime,
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
    await db.addSavedLocation(locName, locAddr, req.teamId);
  }
  if (req.body.return_to) {
    return res.redirect(req.body.return_to);
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

// --- Print Practice Plan ---
app.get('/event/:id/print', requireAdmin, async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event || event.event_type !== 'practice') return res.redirect('/admin');
  const drills = await db.getDrills(event.id);
  const staffList = await db.getAllStaff(req.teamId);
  res.render('practice-print', { event, drills, staffList });
});

// --- Pitch Count Report ---
app.get('/admin/pitch-count-report', requireAdmin, async (req, res) => {
  const startDate = req.query.start || '';
  const endDate = req.query.end || '';
  let report = null;
  if (startDate && endDate) {
    report = await db.getPitchCountReport(startDate, endDate);
  }
  const players = await db.getAllPlayers(req.teamId);
  res.render('pitch-count-report', { startDate, endDate, report, players });
});

// --- Practice Drills ---
app.post('/event/:id/drill', requireAdmin, async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/admin');
  const drills = await db.getDrills(event.id);
  const staffIds = [].concat(req.body.assigned_staff || []).filter(Boolean).join(',');
  await db.addDrill({
    team_event_id: event.id,
    drill_name: (req.body.drill_name || '').trim() || 'New Drill',
    description: (req.body.description || '').trim() || null,
    duration_minutes: parseInt(req.body.duration_minutes) || 10,
    sort_order: drills.length,
    coach_notes: (req.body.coach_notes || '').trim() || null,
    assigned_staff: staffIds || null,
    block_name: (req.body.block_name || '').trim() || null,
    parallel_group: (req.body.parallel_group || '').trim() || null,
  });
  res.redirect('/event/' + event.id);
});

app.post('/event/:id/drill/:drillId/update', requireAdmin, async (req, res) => {
  const staffIds = [].concat(req.body.assigned_staff || []).filter(Boolean).join(',');
  await db.updateDrill(Number(req.params.drillId), {
    drill_name: (req.body.drill_name || '').trim() || 'Drill',
    description: (req.body.description || '').trim() || null,
    duration_minutes: parseInt(req.body.duration_minutes) || 10,
    sort_order: parseInt(req.body.sort_order) || 0,
    coach_notes: (req.body.coach_notes || '').trim() || null,
    assigned_staff: staffIds || null,
    block_name: (req.body.block_name || '').trim() || null,
    parallel_group: (req.body.parallel_group || '').trim() || null,
  });
  res.redirect('/event/' + req.params.id);
});

app.post('/event/:id/drill/reorder', requireAdmin, async (req, res) => {
  const order = req.body.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Invalid order' });
  const drills = await db.getDrills(Number(req.params.id));
  for (let i = 0; i < order.length; i++) {
    const d = drills.find(x => x.id === order[i]);
    if (d) await db.updateDrill(d.id, { drill_name: d.drill_name, description: d.description, duration_minutes: d.duration_minutes, sort_order: i, coach_notes: d.coach_notes, block_name: d.block_name, parallel_group: d.parallel_group });
  }
  res.json({ ok: true });
});

app.post('/event/:id/drill/reorder-blocks', requireAdmin, async (req, res) => {
  const blockOrder = req.body.order; // array of block names in desired order, '' = unassigned
  if (!Array.isArray(blockOrder)) return res.status(400).json({ error: 'Invalid order' });
  const drills = await db.getDrills(Number(req.params.id));
  // Group drills by block, preserving internal order
  const blockDrills = {};
  drills.forEach(d => {
    const bn = d.block_name || '';
    if (!blockDrills[bn]) blockDrills[bn] = [];
    blockDrills[bn].push(d);
  });
  // Rebuild sort order based on new block sequence
  let sortIndex = 0;
  for (const bn of blockOrder) {
    const group = blockDrills[bn] || [];
    for (const d of group) {
      if (d.sort_order !== sortIndex) {
        await db.updateDrill(d.id, { ...d, sort_order: sortIndex });
      }
      sortIndex++;
    }
  }
  // Any blocks not in the submitted order go at the end
  for (const bn of Object.keys(blockDrills)) {
    if (!blockOrder.includes(bn)) {
      for (const d of blockDrills[bn]) {
        if (d.sort_order !== sortIndex) {
          await db.updateDrill(d.id, { ...d, sort_order: sortIndex });
        }
        sortIndex++;
      }
    }
  }
  res.json({ ok: true });
});

app.post('/event/:id/drill/:drillId/copy', requireAdmin, async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/admin');
  const drills = await db.getDrills(event.id);
  const source = drills.find(d => d.id === Number(req.params.drillId));
  if (!source) return res.redirect('/event/' + req.params.id);
  await db.addDrill({
    team_event_id: event.id,
    drill_name: source.drill_name + ' (copy)',
    description: source.description,
    duration_minutes: source.duration_minutes,
    sort_order: drills.length,
    coach_notes: source.coach_notes,
    assigned_staff: source.assigned_staff,
    block_name: source.block_name,
    parallel_group: source.parallel_group,
  });
  res.redirect('/event/' + req.params.id);
});

app.post('/event/:id/drill/copy-block', requireAdmin, async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/admin');
  const drills = await db.getDrills(event.id);
  const blockName = (req.body.block_name || '').trim();
  if (!blockName) return res.redirect('/event/' + req.params.id);
  const blockDrills = drills.filter(d => d.block_name === blockName);
  if (blockDrills.length === 0) return res.redirect('/event/' + req.params.id);
  const newBlockName = blockName + ' (copy)';
  let order = drills.length;
  for (const source of blockDrills) {
    await db.addDrill({
      team_event_id: event.id,
      drill_name: source.drill_name,
      description: source.description,
      duration_minutes: source.duration_minutes,
      sort_order: order++,
      coach_notes: source.coach_notes,
      assigned_staff: source.assigned_staff,
      block_name: newBlockName,
      parallel_group: source.parallel_group,
    });
  }
  res.redirect('/event/' + req.params.id);
});

app.post('/event/:id/drill/update-block', requireAdmin, async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/admin');
  const blockName = (req.body.block_name || '').trim();
  if (!blockName) return res.redirect('/event/' + req.params.id);
  const newBlockName = (req.body.new_block_name || '').trim() || blockName;
  const selectedPartner = (req.body.parallel_group || '').trim() || null;
  const drills = await db.getDrills(event.id);

  if (selectedPartner) {
    // Link this block and the selected partner block with a shared parallel group name
    const groupName = [newBlockName, selectedPartner].sort().join(' + ');
    for (const d of drills) {
      if (d.block_name === blockName) {
        await db.updateDrill(d.id, { ...d, block_name: newBlockName, parallel_group: groupName });
      } else if (d.block_name === selectedPartner) {
        await db.updateDrill(d.id, { ...d, parallel_group: groupName });
      }
    }
  } else {
    // Clear parallel group — also unlink any partner that was only linked to this block
    const oldGroup = drills.find(d => d.block_name === blockName)?.parallel_group;
    for (const d of drills) {
      if (d.block_name === blockName) {
        await db.updateDrill(d.id, { ...d, block_name: newBlockName, parallel_group: null });
      } else if (oldGroup && d.parallel_group === oldGroup) {
        // Check if there are still other blocks in this group besides the one being removed
        const remainingInGroup = drills.filter(x => x.parallel_group === oldGroup && x.block_name !== blockName && x.block_name !== d.block_name);
        if (remainingInGroup.length === 0) {
          // Only two blocks were in this group; clear the partner too
          await db.updateDrill(d.id, { ...d, parallel_group: null });
        }
      }
    }
  }
  res.redirect('/event/' + req.params.id);
});

app.post('/event/:id/drill/:drillId/delete', requireAdmin, async (req, res) => {
  await db.removeDrill(Number(req.params.drillId));
  res.redirect('/event/' + req.params.id);
});

app.post('/event/:id/drill/clear-all', requireAdmin, async (req, res) => {
  await db.clearDrills(Number(req.params.id));
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
  const { sheet, col_name, col_desc, col_duration, col_block, col_notes } = req.body;
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
      block_name: col_block ? String(row[col_block] || '').trim() || null : null,
      coach_notes: col_notes ? String(row[col_notes] || '').trim() || null : null,
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

// API: get past games with lineups for "copy from" feature
app.get('/api/games-with-lineups', requireAdmin, async (req, res) => {
  try {
    const events = await db.getAllTeamEvents(req.teamId);
    const games = events.filter(e => e.event_type === 'game');
    const results = [];
    for (const g of games) {
      const grid = await db.getLineupGrid(g.id, null);
      if (grid.length > 0) {
        results.push({
          id: g.id,
          title: g.title,
          start_date: g.start_date,
          opponent_name: g.opponent_name || '',
          grid: grid.map(r => ({ player_id: r.player_id, batting_order: r.batting_order, inning: r.inning, position_number: r.position_number, status: r.status }))
        });
      }
    }
    results.sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));
    res.json(results);
  } catch (e) {
    res.json([]);
  }
});

app.post('/event/:id/batting-nine', requireAdmin, async (req, res) => {
  const { batting_all } = req.body;
  await db.updateBattingAll(Number(req.params.id), !!batting_all);
  res.json({ ok: true });
});

// New: explicit lineup size (replaces the binary Batting 9 / Bat All toggle).
app.post('/event/:id/lineup-size', requireAdmin, async (req, res) => {
  const size = Number(req.body.lineup_size);
  if (!Number.isFinite(size) || size < 1 || size > 20) {
    return res.status(400).json({ ok: false, error: 'lineup_size must be 1-20' });
  }
  await db.updateLineupSize(Number(req.params.id), size);
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
  const players = await db.getAllPlayers(req.teamId);
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
  const players = await db.getAllPlayers(req.teamId);
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
  const currentAdmin = await db.getAdminById(req.session.admin.id);
  res.render('admin-settings', {
    adminUser: req.session.admin,
    adminEmail: currentAdmin ? currentAdmin.email || '' : '',
    adminDisplayName: currentAdmin ? currentAdmin.display_name || '' : '',
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

app.post('/admin/update-email', requireAdmin, async (req, res) => {
  const email = (req.body.email || '').trim();
  await db.updateAdminEmail(req.session.admin.id, email || null);
  res.redirect('/admin/settings?success=' + encodeURIComponent(email ? 'Email updated.' : 'Email removed.'));
});

app.post('/admin/update-display-name', requireAdmin, async (req, res) => {
  const displayName = (req.body.display_name || '').trim();
  if (!displayName) {
    return res.redirect('/admin/settings?error=' + encodeURIComponent('Display name cannot be empty.'));
  }
  await db.updateAdminDisplayName(req.session.admin.id, displayName);
  req.session.admin.displayName = displayName;
  res.redirect('/admin/settings?success=' + encodeURIComponent('Display name updated.'));
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

app.get('/messages', requireParentOrAdmin, async (req, res, next) => {
  try {
    const topics = await db.getAllMessages(req.teamId);
    const topicReplies = {};
    for (const t of topics) {
      topicReplies[t.id] = await db.getTopicReplies(t.id);
    }
    const allMsgIds = topics.map(t => t.id);
    for (const replies of Object.values(topicReplies)) {
      for (const r of replies) allMsgIds.push(r.id);
    }
    const reactions = await db.getReactionsForMessages(allMsgIds);
    const isAdmin = !!req.session.admin;
    let currentUserName = null;
    if (isAdmin) currentUserName = req.session.admin.displayName || 'Coach';
    else if (req.parentUser) currentUserName = req.parentUser.display_name;
    res.render('messages', { topics, topicReplies, reactions, currentUserName, isAdmin, parentUser: req.parentUser || null, error: req.query.error || null, success: req.query.success || null });
  } catch (err) {
    console.error('Messages route error:', err.message, err.stack);
    next(err);
  }
});

app.post('/messages', async (req, res) => {
  const isAdmin = !!req.session.admin;
  const message = (req.body.message || '').trim();
  if (!message) return res.redirect('/messages?error=' + encodeURIComponent('Message cannot be empty.'));

  let authorName, authorType;
  if (isAdmin) {
    authorName = req.session.admin.displayName || 'Coach';
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

  await db.addMessage({ author_name: authorName, author_type: authorType, message, team_id: req.teamId });
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

  await db.addMessage({ author_name: authorName, author_type: authorType, message, parent_id: topicId, team_id: req.teamId });
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

app.post('/messages/react', async (req, res) => {
  const isAdmin = !!req.session.admin;
  const messageId = Number(req.body.message_id);
  const reactionType = req.body.reaction_type;
  if (!['up', 'down'].includes(reactionType)) return res.redirect('/messages');

  let authorName;
  if (isAdmin) authorName = req.session.admin.username;
  else if (req.parentUser) authorName = req.parentUser.display_name;
  else return res.redirect('/messages');

  await db.toggleReaction(messageId, authorName, reactionType);
  res.redirect('/messages');
});

// --- Live Scoring System ---

function requireScoreKeeper(req, res, next) {
  const token = req.query.token || req.session.scoreToken;
  if (token) {
    req.scoreToken = token;
    if (!req.session.scoreToken) req.session.scoreToken = token;
    return next();
  }
  if (req.session.admin) {
    req.isAdminScorer = true;
    return next();
  }
  return res.status(401).send('Scoring access required. Use your scorekeeper link.');
}

async function refreshScorerHeartbeat(req) {
  const gameId = Number(req.params.id);
  if (!gameId) return;
  let name;
  if (req.isAdminScorer) {
    name = req.session.admin.username || 'Admin';
  } else if (req.scoreToken) {
    const k = await db.getScoreKeeperByToken(req.scoreToken);
    name = k ? k.name : 'Unknown';
  }
  if (name) await db.updateGameState(gameId, { active_scorer_name: name, active_scorer_at: new Date().toISOString() });
}

app.get('/admin/scorekeepers', requireAdmin, async (req, res) => {
  const keepers = await db.getAllScoreKeepers(req.teamId);
  res.json(keepers);
});

app.post('/admin/scorekeepers', requireAdmin, async (req, res) => {
  const { name, phone, email } = req.body;
  const token = crypto.randomBytes(24).toString('hex');
  await db.addScoreKeeper({ name, phone: phone || null, email: email || null, access_token: token, team_id: req.teamId });
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
  const accounts = await db.getAllParentAccounts(req.teamId);
  const result = [];
  for (const a of accounts) {
    const linked = await db.getLinkedPlayersByAccount(a.id, req.teamId);
    result.push({ id: a.id, phone: a.phone, username: a.username || '', display_name: a.display_name, created_at: a.created_at, role: a.role || 'parent', approved: a.approved !== false && a.approved !== 0, players: linked.map(p => ({ id: p.id, name: p.player_name })) });
  }
  res.json(result);
});

// --- Global account admin (all teams) ---
// The per-team accounts list only shows accounts with a player on that team.
// This section is the place to see/manage every account across all seasons,
// and to search for an existing parent to attach to the current team.
app.get('/admin/accounts-global', requireAdmin, async (req, res) => {
  const teams = await db.getAllTeams();
  const currentPlayers = await db.getAllPlayers(req.teamId);
  res.render('admin-accounts-global', {
    teams,
    currentTeam: res.locals.currentTeam,
    currentPlayers,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

// JSON search across ALL accounts (used by the global page + the add-to-team picker).
app.get('/admin/accounts-global/search', requireAdmin, async (req, res) => {
  const rows = await db.searchParentAccounts(req.query.q || '');
  res.json(rows.map(r => ({
    id: r.id,
    display_name: r.display_name,
    phone: r.phone,
    username: r.username || '',
    role: r.role || 'parent',
    approved: r.approved !== false && r.approved !== 0,
    player_count: Number(r.player_count) || 0,
    teams: (typeof r.teams === 'string' ? JSON.parse(r.teams) : (r.teams || [])),
  })));
});

// Attach an existing account to the current team by linking it to one of
// this team's players (membership is defined by that link).
app.post('/admin/accounts-global/:id/add-to-team', requireAdmin, async (req, res) => {
  const accountId = Number(req.params.id);
  const playerId = Number(req.body.player_id);
  const account = await db.getParentAccountById(accountId);
  if (!account) return res.json({ ok: false, error: 'Account not found.' });
  const player = await db.getPlayer(playerId);
  if (!player) return res.json({ ok: false, error: 'Player not found.' });
  if (player.team_id !== req.teamId) {
    return res.json({ ok: false, error: 'That player is not on the current team.' });
  }
  await db.linkPlayerToAccount(playerId, accountId);
  res.json({ ok: true });
});

app.post('/admin/accounts/create', requireAdmin, async (req, res) => {
  const { phone, display_name, password, player_ids, username } = req.body;
  const normalized = normalizePhone(phone || '');
  if (normalized.length !== 10) return res.json({ ok: false, error: 'Invalid phone number.' });
  if (!display_name || !display_name.trim()) return res.json({ ok: false, error: 'Name is required.' });
  if (!password || password.length < 6) return res.json({ ok: false, error: 'Password must be at least 6 characters.' });

  const existing = await db.getParentAccountByPhone(normalized);
  if (existing) return res.json({ ok: false, error: 'An account already exists for this phone number.' });

  if (username && username.trim()) {
    const usernameClash = await db.getParentAccountByUsername(username.trim());
    if (usernameClash) return res.json({ ok: false, error: 'Username already taken.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const newAccount = await db.createParentAccountFull(normalized, display_name.trim(), hash, 'parent', true);
  if (username && username.trim()) {
    await db.updateParentAccountUsername(newAccount.id, username.trim());
  }

  if (player_ids && player_ids.length > 0) {
    for (const pid of player_ids) {
      await db.linkPlayerToAccount(Number(pid), newAccount.id);
    }
  }

  const baseUrl = process.env.BASE_URL || 'https://cal-ripken-allstars.onrender.com';
  const formattedPhone = normalized.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3');
  const teamName = (await db.getSetting('team_name')) || 'Cal Ripken All-Stars';
  const loginInfo = username && username.trim() ? `Username: ${username.trim()}` : `Phone: ${formattedPhone}`;
  const smsBody = `${teamName}: Your parent account is ready!\n\nLogin: ${baseUrl}/parent/login\n${loginInfo}\nPassword: ${password}\n\nSign in to view the schedule, RSVPs, and lineups.`;
  await sendSMS(normalized, smsBody);

  res.json({ ok: true, smsSent: !!(twilioClient && twilioFrom) });
});

app.post('/admin/accounts/:id/update', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { display_name, phone, username } = req.body;
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
    await db.updateParentAccountPhone(id, normalized);
  }
  if (username !== undefined) {
    if (username && username.trim()) {
      const clash = await db.getParentAccountByUsername(username.trim());
      if (clash && clash.id !== id) return res.json({ ok: false, error: 'Username already taken.' });
      await db.updateParentAccountUsername(id, username.trim());
    } else {
      await db.updateParentAccountUsername(id, null);
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
  await db.linkPlayerToAccount(Number(player_id), id);
  res.json({ ok: true });
});

app.post('/admin/accounts/:id/unlink-player', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { player_id } = req.body;
  await db.unlinkPlayerFromAccount(Number(player_id), id);
  res.json({ ok: true });
});

app.post('/admin/accounts/:id/delete', requireAdmin, async (req, res) => {
  await db.deleteParentAccount(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/admin/accounts/:id/make-staff', requireAdmin, async (req, res) => {
  const account = await db.getParentAccountById(Number(req.params.id));
  if (!account) return res.json({ ok: false, error: 'Account not found.' });
  const existing = await db.getStaffByPhone(account.phone, req.teamId);
  if (existing) return res.json({ ok: false, error: 'Already a staff member.' });
  await db.addStaff({ name: account.display_name, role: 'Parent', phone: account.phone, email: null, team_id: req.teamId });
  res.json({ ok: true });
});

app.post('/admin/accounts/:id/make-scorekeeper', requireAdmin, async (req, res) => {
  const account = await db.getParentAccountById(Number(req.params.id));
  if (!account) return res.json({ ok: false, error: 'Account not found.' });
  // Check if already a scorekeeper (by phone)
  const existing = await db.getAllScoreKeepers(req.teamId);
  if (existing.some(k => k.phone === account.phone)) {
    return res.json({ ok: false, error: account.display_name + ' is already a scorekeeper.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  await db.addScoreKeeper({ name: account.display_name, phone: account.phone || null, email: null, access_token: token, team_id: req.teamId });
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const link = `${baseUrl}/score/${token}`;
  // Send SMS with scorekeeper link
  if (account.phone) {
    const teamName = (await db.getSetting('team_name')) || 'Cal Ripken All-Stars';
    await sendSMS(account.phone, `${teamName}: You've been added as a scorekeeper! Access live scoring here: ${link}`);
  }
  res.json({ ok: true, link });
});

app.post('/admin/accounts/:id/approve', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const account = await db.getParentAccountById(id);
  if (!account) return res.json({ ok: false, error: 'Account not found.' });
  await db.updateAccountApproved(id, true);
  res.json({ ok: true });
});

app.post('/admin/accounts/:id/deny', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const account = await db.getParentAccountById(id);
  if (!account) return res.json({ ok: false, error: 'Account not found.' });
  await db.deleteParentAccount(id);
  res.json({ ok: true });
});

app.post('/admin/accounts/:id/set-role', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { role } = req.body;
  if (!['parent', 'fan'].includes(role)) return res.json({ ok: false, error: 'Invalid role.' });
  await db.updateAccountRole(id, role);
  res.json({ ok: true });
});

app.get('/admin/pending-fans', requireAdmin, async (req, res) => {
  const pending = await db.getPendingFanAccounts(req.teamId);
  const players = await db.getAllPlayers(req.teamId);
  const playerMap = {};
  for (const p of players) playerMap[p.id] = p.player_name;
  const result = pending.map(f => ({
    ...f,
    player_names: (f.player_ids || []).filter(id => id).map(id => playerMap[id] || 'Unknown')
  }));
  res.json(result);
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
  const games = await db.getAllActiveGames(keeper.team_id || req.teamId);
  if (games.length === 1) return res.redirect('/game/' + games[0].id + '/score?token=' + req.params.token);
  res.render('score-home', { keeper, games, token: req.params.token });
});

app.get('/game/setup/:eventId', requireAdmin, async (req, res) => {
  const eventId = Number(req.params.eventId);
  const subEventId = req.query.sub ? Number(req.query.sub) : null;
  const event = subEventId ? await db.getSubEvent(subEventId) : await db.getTeamEvent(eventId);
  if (!event) return res.redirect('/admin');
  const parentEvent = subEventId ? await db.getTeamEvent(eventId) : null;
  const players = (await db.getAllPlayers(req.teamId)).filter(p => p.status === 'confirmed');
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
  const updates = { status: 'active', current_half: half, started_at: new Date().toISOString() };
  // Auto-set starting pitcher from roster if not already set
  if (!game.current_pitcher_us) {
    const roster = await db.getGameRoster(id);
    const pitcher = roster.find(r => r.current_position === 1);
    if (pitcher) updates.current_pitcher_us = pitcher.player_id;
  }
  await db.updateGameState(id, updates);
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

  let keeper;
  let scorerName;
  if (req.isAdminScorer) {
    scorerName = req.session.admin.username || 'Admin';
    keeper = { name: scorerName };
  } else {
    keeper = await db.getScoreKeeperByToken(req.scoreToken);
    scorerName = keeper ? keeper.name : 'Unknown';
  }

  const ACTIVE_TIMEOUT_MS = 5 * 60 * 1000;
  if (game.active_scorer_name && game.active_scorer_at) {
    const elapsed = Date.now() - new Date(game.active_scorer_at).getTime();
    if (elapsed < ACTIVE_TIMEOUT_MS && game.active_scorer_name !== scorerName) {
      return res.status(409).send(`${game.active_scorer_name} is currently scoring this game. Try again later or ask them to close the scoring page.`);
    }
  }

  await db.updateGameState(game.id, { active_scorer_name: scorerName, active_scorer_at: new Date().toISOString() });

  const roster = await db.getGameRoster(game.id);
  const oppRoster = await db.getOppRoster(game.id);
  res.render('game-score', { game, keeper, roster, oppRoster, token: req.scoreToken || '' });
});

app.get('/api/game/:id/state', async (req, res) => {
  res.set('Cache-Control', 'no-store');
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
  refreshScorerHeartbeat(req);
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
  refreshScorerHeartbeat(req);
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
  refreshScorerHeartbeat(req);
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
  refreshScorerHeartbeat(req);
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
  refreshScorerHeartbeat(req);
  const gameId = Number(req.params.id);
  const { roster_id, position } = req.body;
  if (roster_id) {
    await db.updateRosterEntry(Number(roster_id), { current_position: position ? Number(position) : null });
  }
  res.json({ ok: true });
});

app.post('/api/game/:id/substitute', requireScoreKeeper, async (req, res) => {
  const gameId = Number(req.params.id);
  const game = await db.getLiveGame(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const { player_in_id, player_out_id, position, batting_order } = req.body;
  const roster = await db.getGameRoster(gameId);

  if (player_out_id) {
    const outEntry = roster.find(r => r.player_id === player_out_id);
    if (outEntry) {
      await db.updateRosterEntry(outEntry.id, { is_active: 0, exited_inning: game.current_inning, current_position: null });
    }
  }

  if (player_in_id) {
    const inEntry = roster.find(r => r.player_id === player_in_id);
    if (inEntry) {
      const updates = { is_active: 1, entered_inning: game.current_inning };
      if (position) updates.current_position = Number(position);
      if (batting_order !== undefined) updates.batting_order = Number(batting_order);
      await db.updateRosterEntry(inEntry.id, updates);
    }
  }

  if (position && !player_in_id && !player_out_id) {
    const { roster_id } = req.body;
    if (roster_id) {
      await db.updateRosterEntry(Number(roster_id), { current_position: Number(position) });
    }
  }

  res.json({ ok: true });
});

app.post('/api/game/:id/dead-ball', requireScoreKeeper, async (req, res) => {
  const gameId = Number(req.params.id);
  const game = await db.getLiveGame(gameId);
  if (!game || game.status !== 'active') return res.status(400).json({ error: 'Game not active' });

  const { type, runner_from, runner_out } = req.body;
  const prevState = JSON.stringify({
    outs: game.outs, our_score: game.our_score, opp_score: game.opp_score,
    runner_first: game.runner_first, runner_second: game.runner_second, runner_third: game.runner_third,
    current_half: game.current_half, current_inning: game.current_inning
  });

  const weAreBatting = (game.home_away === 'home' && game.current_half === 'bot') || (game.home_away === 'away' && game.current_half === 'top');
  const updates = {};
  let rf = game.runner_first, rs = game.runner_second, rt = game.runner_third;

  if (type === 'SB' || type === 'WP' || type === 'PB' || type === 'balk') {
    if (type === 'SB' && runner_from) {
      if (runner_from === 'first') { rs = rf; rf = null; }
      else if (runner_from === 'second') { rt = rs; rs = null; }
      else if (runner_from === 'third') {
        if (weAreBatting) updates.our_score = game.our_score + 1;
        else updates.opp_score = game.opp_score + 1;
        rt = null;
      }
    } else if (type !== 'SB') {
      if (rt) {
        if (weAreBatting) updates.our_score = (updates.our_score !== undefined ? updates.our_score : game.our_score) + 1;
        else updates.opp_score = (updates.opp_score !== undefined ? updates.opp_score : game.opp_score) + 1;
        rt = null;
      }
      if (rs) { rt = rs; rs = null; }
      if (rf) { rs = rf; rf = null; }
    }
  } else if (type === 'pickoff' && runner_out) {
    if (runner_out === 'first') rf = null;
    else if (runner_out === 'second') rs = null;
    else if (runner_out === 'third') rt = null;
    const newOuts = game.outs + 1;
    if (newOuts >= 3) {
      const nextHalf = game.current_half === 'top' ? 'bot' : 'top';
      const nextInning = game.current_half === 'bot' ? game.current_inning + 1 : game.current_inning;
      updates.outs = 0;
      updates.current_half = nextHalf;
      updates.current_inning = nextInning;
      rf = null; rs = null; rt = null;
    } else {
      updates.outs = newOuts;
    }
  }

  updates.runner_first = rf;
  updates.runner_second = rs;
  updates.runner_third = rt;

  await db.pushUndo(gameId, 'dead_ball', JSON.stringify({ type }), prevState);
  await db.updateGameState(gameId, updates);
  res.json({ ok: true });
});

app.post('/api/game/:id/swap-positions', requireScoreKeeper, async (req, res) => {
  const gameId = Number(req.params.id);
  const { roster_id_a, roster_id_b } = req.body;
  const roster = await db.getGameRoster(gameId);
  const a = roster.find(r => r.id === Number(roster_id_a));
  const b = roster.find(r => r.id === Number(roster_id_b));
  if (a && b) {
    const posA = a.current_position;
    await db.updateRosterEntry(a.id, { current_position: b.current_position });
    await db.updateRosterEntry(b.id, { current_position: posA });
  }
  res.json({ ok: true });
});

app.get('/game/:id/coach', async (req, res) => {
  const game = await db.getLiveGame(Number(req.params.id));
  if (!game) return res.status(404).send('Game not found');
  res.render('game-coach', { game });
});

app.get('/api/game/:id/dashboard', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
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
        let stressPitches = 0;
        for (const p of pp) {
          try {
            const ro = p.runners_on ? JSON.parse(p.runners_on) : {};
            const rISP = ro.second || ro.third;
            if (rISP || p.pitch_number_in_ab >= 5) stressPitches++;
          } catch (e) { /* skip malformed runners_on */ }
        }

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
  } catch (err) {
    console.error('Dashboard API error:', err);
    res.status(500).json({ error: 'Dashboard error' });
  }
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

app.get('/stats', requireParentOrAdmin, async (req, res) => {
  const isAdmin = req.session && req.session.admin;
  const isStaff = req.query.phone && await db.getStaffByPhone(normalizePhone(req.query.phone), req.teamId);
  const parentUser = req.parentUser;
  const teamName = await db.getSetting('team_name') || 'Cal Ripken All-Stars';
  res.render('player-stats', { isAdmin: !!isAdmin, isStaff: !!isStaff, parentUser: parentUser || null, teamName });
});

app.get('/api/player-stats/:playerId', async (req, res) => {
  const playerId = Number(req.params.playerId);
  const isAdmin = req.session && req.session.admin;
  const isStaff = req.query.phone && await db.getStaffByPhone(normalizePhone(req.query.phone), req.teamId);
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

  // Include GameChanger imported stats if available
  const gcBatting = (await db.getGcImportedStats('batting')).find(s => s.player_id === playerId);
  const gcPitching = (await db.getGcImportedStats('pitching')).find(s => s.player_id === playerId);
  const imported = {};
  if (gcBatting) imported.batting = JSON.parse(gcBatting.stats_json || '{}');
  if (gcPitching) imported.pitching = JSON.parse(gcPitching.stats_json || '{}');

  res.json({ player: { id: player.id, player_name: player.player_name, jersey_number: player.jersey_number }, batting, pitching, imported });
});

app.get('/api/team-stats', async (req, res) => {
  const isAdmin = req.session && req.session.admin;
  const isStaff = req.query.phone && await db.getStaffByPhone(normalizePhone(req.query.phone), req.teamId);
  const parentUser = req.parentUser;
  const parentOnly = !isAdmin && !isStaff && parentUser;
  if (!isAdmin && !isStaff && !parentOnly) return res.status(403).json({ error: 'Not authorized' });

  let players = (await db.getAllPlayers(req.teamId)).filter(p => p.status === 'confirmed');
  if (parentOnly) players = players.filter(p => parentUser.player_ids.includes(p.id));

  const batting = [];
  const pitching = [];
  for (const p of players) {
    const atBats = await db.getAtBatsForPlayer(p.id);
    const completed = atBats.filter(ab => ab.result);
    const hits = completed.filter(ab => ['1B','2B','3B','HR'].includes(ab.result)).length;
    const abs = completed.filter(ab => !['BB','HBP','SAC'].includes(ab.result)).length;
    const rbis = completed.reduce((s, ab) => s + (ab.rbi_count || 0), 0);
    const bbs = completed.filter(ab => ab.result === 'BB' || ab.result === 'HBP').length;
    const ks = completed.filter(ab => ab.result === 'K').length;
    const doubles = completed.filter(ab => ab.result === '2B').length;
    const triples = completed.filter(ab => ab.result === '3B').length;
    const hrs = completed.filter(ab => ab.result === 'HR').length;
    batting.push({ player_id: p.id, player_name: p.player_name, jersey_number: p.jersey_number, hits, abs, avg: abs > 0 ? (hits / abs).toFixed(3) : '-', rbis, bbs, ks, doubles, triples, hrs, pa: completed.length });

    const pitchData = await db.getPitchesForPitcherSeason(p.id);
    if (pitchData.length > 0) {
      const strikes = pitchData.filter(pt => ['called_strike','swinging_strike','foul','foul_tip','in_play'].includes(pt.result)).length;
      const gameGroups = {};
      for (const pt of pitchData) { if (!gameGroups[pt.game_id]) gameGroups[pt.game_id] = []; gameGroups[pt.game_id].push(pt); }
      pitching.push({ player_id: p.id, player_name: p.player_name, jersey_number: p.jersey_number, totalPitches: pitchData.length, strikes, balls: pitchData.length - strikes, strikePercent: Math.round((strikes / pitchData.length) * 100), games: Object.keys(gameGroups).length });
    }
  }

  // Include GameChanger imported data
  const gcBattingAll = await db.getGcImportedStats('batting');
  const gcPitchingAll = await db.getGcImportedStats('pitching');
  const gcBatting = {};
  gcBattingAll.forEach(s => { if (s.player_id) gcBatting[s.player_id] = JSON.parse(s.stats_json || '{}'); });
  const gcPitching = {};
  gcPitchingAll.forEach(s => { if (s.player_id) gcPitching[s.player_id] = JSON.parse(s.stats_json || '{}'); });

  res.json({ batting, pitching, gcBatting, gcPitching });
});

// ── GameChanger Import ──
app.get('/admin/import-stats', requireAdmin, async (req, res) => {
  const players = (await db.getAllPlayers(req.teamId)).filter(p => p.status === 'confirmed');
  const existing = await db.getAllGcStats(req.teamId);
  res.render('import-stats', { players, existing, success: req.query.success || null, error: req.query.error || null });
});

app.post('/admin/import-stats', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.redirect('/admin/import-stats?error=No+file+uploaded');
    const statType = req.body.stat_type || 'batting';
    const source = req.body.source || 'gamechanger';

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) return res.redirect('/admin/import-stats?error=File+is+empty');

    const headers = Object.keys(rows[0]);
    const players = (await db.getAllPlayers(req.teamId)).filter(p => p.status === 'confirmed');

    // Detect name columns — GameChanger uses # / Last / First or Player / #
    const hasLast = headers.some(h => h.toLowerCase() === 'last');
    const hasFirst = headers.some(h => h.toLowerCase() === 'first');
    const hasPlayer = headers.some(h => h.toLowerCase() === 'player');
    const hasNum = headers.some(h => h === '#' || h.toLowerCase() === 'number');

    // Clear old data for this type+source before re-importing
    await db.deleteGcStats(statType, source);

    let imported = 0;
    for (const row of rows) {
      // Build player name from CSV
      let gcName = '';
      if (hasLast && hasFirst) {
        const last = (row['Last'] || row['last'] || '').toString().trim();
        const first = (row['First'] || row['first'] || '').toString().trim();
        if (!last && !first) continue;
        gcName = first + ' ' + last;
      } else if (hasPlayer) {
        gcName = (row['Player'] || row['player'] || '').toString().trim();
        if (!gcName) continue;
      } else {
        // Try first text column
        const firstKey = headers[0];
        gcName = (row[firstKey] || '').toString().trim();
        if (!gcName || /^[0-9.]+$/.test(gcName)) continue;
      }

      // Skip totals/summary rows
      if (/^total/i.test(gcName) || /^team/i.test(gcName)) continue;

      const gcNum = hasNum ? (row['#'] || row['Number'] || row['number'] || '').toString().trim() : '';

      // Auto-match to our roster
      let matchedPlayer = null;
      const gcLower = gcName.toLowerCase().replace(/[^a-z]/g, '');
      for (const p of players) {
        const pLower = p.player_name.toLowerCase().replace(/[^a-z]/g, '');
        // Match by full name
        if (pLower === gcLower) { matchedPlayer = p; break; }
        // Match by last name + jersey number
        const gcParts = gcName.toLowerCase().split(/\s+/);
        const pParts = p.player_name.toLowerCase().split(/\s+/);
        if (gcParts.length && pParts.length && gcParts[gcParts.length - 1] === pParts[pParts.length - 1]) {
          if (gcNum && p.jersey_number && gcNum === p.jersey_number.toString()) { matchedPlayer = p; break; }
          if (!matchedPlayer) matchedPlayer = p; // tentative last name match
        }
      }

      // Override match if admin mapped this player via form
      const manualMap = req.body['map_' + imported];
      if (manualMap) {
        matchedPlayer = players.find(p => p.id === Number(manualMap)) || matchedPlayer;
      }

      // Build stats object from all numeric columns
      const stats = {};
      for (const h of headers) {
        const key = h.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/^_+|_+$/g, '');
        if (['last','first','player','name'].includes(key)) continue;
        const val = row[h];
        if (val === '' || val === null || val === undefined) continue;
        const num = parseFloat(val);
        stats[key] = isNaN(num) ? val.toString() : num;
      }

      await db.upsertGcStats(
        matchedPlayer ? matchedPlayer.id : null,
        gcName,
        statType,
        JSON.stringify(stats),
        source
      );
      imported++;
    }

    res.redirect('/admin/import-stats?success=Imported+' + imported + '+' + statType + '+rows');
  } catch (err) {
    console.error('GC import error:', err);
    res.redirect('/admin/import-stats?error=' + encodeURIComponent(err.message || 'Import failed'));
  }
});

app.post('/admin/import-stats/clear', requireAdmin, async (req, res) => {
  const statType = req.body.stat_type || 'batting';
  const source = req.body.source || 'gamechanger';
  await db.deleteGcStats(statType, source);
  res.redirect('/admin/import-stats?success=Cleared+' + statType + '+imported+data');
});

app.get('/api/gc-stats', requireAdmin, async (req, res) => {
  const stats = await db.getAllGcStats(req.teamId);
  res.json(stats.map(s => ({ ...s, stats: JSON.parse(s.stats_json || '{}') })));
});

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  return date.toISOString().split('T')[0];
}

app.get('/programs', requireParentOrAdmin, async (req, res) => {
  const programs = await db.getPublishedPrograms(req.teamId);
  const playerAssignments = {};
  if (req.parentUser) {
    for (const pid of req.parentUser.player_ids) {
      playerAssignments[pid] = await db.getPlayerAssignments(pid);
    }
  }
  res.render('programs', { programs, parentUser: req.parentUser || null, playerAssignments });
});

app.get('/programs/:id', requireParentOrAdmin, async (req, res) => {
  const program = await db.getProgram(Number(req.params.id));
  if (!program || (!program.published && !req.session.admin)) return res.redirect('/programs');
  const days = await db.getProgramDays(program.id);
  for (const day of days) {
    day.activities = await db.getProgramActivities(day.id);
  }
  const isAdmin = !!req.session.admin;
  const assignments = isAdmin ? await db.getProgramAssignments(program.id) : [];
  const players = isAdmin ? (await db.getAllPlayers(req.teamId)).filter(p => p.status === 'confirmed') : [];
  const subscribedPlayerIds = [];
  if (req.parentUser) {
    for (const pid of req.parentUser.player_ids) {
      const pa = await db.getPlayerAssignments(pid);
      if (pa.some(a => a.program_id === program.id)) subscribedPlayerIds.push(pid);
    }
  }
  const allPlayers = await db.getAllPlayers(req.teamId);
  // Gather completions for subscribed players this week
  const weekOf = getMonday(new Date());
  const playerCompletions = {};
  for (const pid of subscribedPlayerIds) {
    playerCompletions[pid] = await db.getCompletions(program.id, pid);
  }
  const equipment = await db.getProgramEquipment(program.id);
  res.render('program-detail', { program, days, isAdmin, assignments, players, parentUser: req.parentUser || null, subscribedPlayerIds, allPlayers, weekOf, playerCompletions, equipment });
});

app.post('/programs/:id/subscribe', async (req, res) => {
  const program = await db.getProgram(Number(req.params.id));
  if (!program || !program.published) return res.redirect('/programs');
  const playerId = Number(req.body.player_id);
  if (!req.parentUser || !req.parentUser.player_ids.includes(playerId)) return res.redirect('/programs/' + req.params.id);
  const reminders = req.body.reminders === '1' ? 1 : 0;
  await db.assignProgram({ program_id: program.id, player_id: playerId, send_reminders: reminders });
  res.redirect('/programs/' + program.id);
});

app.post('/programs/:id/unsubscribe', async (req, res) => {
  const playerId = Number(req.body.player_id);
  if (!req.parentUser || !req.parentUser.player_ids.includes(playerId)) return res.redirect('/programs/' + req.params.id);
  await db.unassignProgram(Number(req.params.id), playerId);
  res.redirect('/programs/' + req.params.id);
});

app.get('/admin/programs', requireAdmin, async (req, res) => {
  const programs = await db.getAllPrograms(req.teamId);
  res.render('admin-programs', { programs, success: req.query.success || null, error: req.query.error || null });
});

app.post('/admin/programs', requireAdmin, async (req, res) => {
  const { title, description, author, program_type, schedule_type } = req.body;
  if (!title || !title.trim()) return res.redirect('/admin/programs?error=Title+is+required');
  const result = await db.addProgram({ title: title.trim(), description: (description || '').trim() || null, author: (author || '').trim() || null, program_type: program_type || 'at_home', schedule_type: schedule_type || 'weekly', team_id: req.teamId });
  res.redirect('/admin/programs/' + result.id + '/edit');
});

app.get('/admin/programs/:id/edit', requireAdmin, async (req, res) => {
  try {
    const program = await db.getProgram(Number(req.params.id));
    if (!program) return res.redirect('/admin/programs');
    const days = await db.getProgramDays(program.id);
    for (const day of days) {
      day.activities = await db.getProgramActivities(day.id);
    }
    const assignments = await db.getProgramAssignments(program.id);
    const players = (await db.getAllPlayers(req.teamId)).filter(p => p.status === 'confirmed');
    const equipment = await db.getProgramEquipment(program.id);
    res.render('admin-program-edit', { program, days, assignments, players, equipment, success: req.query.success || null, error: req.query.error || null, POSITIONS });
  } catch (err) {
    console.error('Program edit page error:', err);
    res.redirect('/admin/programs?error=' + encodeURIComponent(err.message));
  }
});

app.post('/admin/programs/:id/update', requireAdmin, async (req, res) => {
  const { title, description, author, program_type, schedule_type, published } = req.body;
  await db.updateProgram(Number(req.params.id), { title: (title || '').trim(), description: (description || '').trim() || null, author: (author || '').trim() || null, program_type: program_type || 'at_home', schedule_type: schedule_type || 'weekly', published: published === '1' ? 1 : 0 });
  res.redirect('/admin/programs/' + req.params.id + '/edit?success=Program+updated');
});

app.post('/admin/programs/:id/delete', requireAdmin, async (req, res) => {
  await db.removeProgram(Number(req.params.id));
  res.redirect('/admin/programs?success=Program+deleted');
});

app.post('/admin/programs/:id/day', requireAdmin, async (req, res) => {
  const program = await db.getProgram(Number(req.params.id));
  if (!program) return res.redirect('/admin/programs');
  const days = await db.getProgramDays(program.id);
  const dayLabel = (req.body.day_label || '').trim() || ('Day ' + (days.length + 1));
  const newDay = await db.addProgramDay({ program_id: program.id, day_label: dayLabel, day_number: days.length, sort_order: days.length });
  res.redirect('/admin/programs/' + program.id + '/edit#day-' + newDay.id);
});

app.post('/admin/programs/:id/day/:dayId/update', requireAdmin, async (req, res) => {
  await db.updateProgramDay(Number(req.params.dayId), { day_label: (req.body.day_label || '').trim() || 'Day', day_number: parseInt(req.body.day_number) || 0, sort_order: parseInt(req.body.sort_order) || 0 });
  res.redirect('/admin/programs/' + req.params.id + '/edit#day-' + req.params.dayId);
});

app.post('/admin/programs/:id/day/:dayId/delete', requireAdmin, async (req, res) => {
  await db.removeProgramDay(Number(req.params.dayId));
  res.redirect('/admin/programs/' + req.params.id + '/edit#days-section');
});

app.post('/admin/programs/:id/day/:dayId/activity', requireAdmin, async (req, res) => {
  const activities = await db.getProgramActivities(Number(req.params.dayId));
  await db.addProgramActivity({
    program_day_id: Number(req.params.dayId),
    activity_name: (req.body.activity_name || '').trim() || 'New Activity',
    description: (req.body.description || '').trim() || null,
    instructions: (req.body.instructions || '').trim() || null,
    reps: (req.body.reps || '').trim() || null,
    link_url: (req.body.link_url || '').trim() || null,
    image_url: (req.body.image_url || '').trim() || null,
    sort_order: activities.length,
  });
  res.redirect('/admin/programs/' + req.params.id + '/edit#day-' + req.params.dayId);
});

app.post('/admin/programs/:id/activity/:actId/update', requireAdmin, async (req, res) => {
  const dayId = req.body.program_day_id || '';
  await db.updateProgramActivity(Number(req.params.actId), {
    activity_name: (req.body.activity_name || '').trim() || 'Activity',
    description: (req.body.description || '').trim() || null,
    instructions: (req.body.instructions || '').trim() || null,
    reps: (req.body.reps || '').trim() || null,
    link_url: (req.body.link_url || '').trim() || null,
    image_url: (req.body.image_url || '').trim() || null,
    sort_order: parseInt(req.body.sort_order) || 0,
  });
  res.redirect('/admin/programs/' + req.params.id + '/edit#day-' + dayId);
});

app.post('/admin/programs/:id/activity/:actId/delete', requireAdmin, async (req, res) => {
  const dayId = req.body.program_day_id || '';
  await db.removeProgramActivity(Number(req.params.actId));
  res.redirect('/admin/programs/' + req.params.id + '/edit#day-' + dayId);
});

app.post('/admin/programs/:id/equipment', requireAdmin, async (req, res) => {
  const { item_name, is_required, buy_url } = req.body;
  if (!item_name || !item_name.trim()) return res.redirect('/admin/programs/' + req.params.id + '/edit?error=Item+name+is+required');
  const existing = await db.getProgramEquipment(Number(req.params.id));
  await db.addProgramEquipment({ program_id: Number(req.params.id), item_name: item_name.trim(), is_required: is_required === '1' ? 1 : 0, buy_url: (buy_url || '').trim() || null, sort_order: existing.length });
  res.redirect('/admin/programs/' + req.params.id + '/edit?success=Equipment+added');
});

app.post('/admin/programs/:id/equipment/:eqId/update', requireAdmin, async (req, res) => {
  const { item_name, is_required, buy_url } = req.body;
  await db.updateProgramEquipment(Number(req.params.eqId), { item_name: (item_name || '').trim(), is_required: is_required === '1' ? 1 : 0, buy_url: (buy_url || '').trim() || null, sort_order: Number(req.body.sort_order) || 0 });
  res.redirect('/admin/programs/' + req.params.id + '/edit?success=Equipment+updated');
});

app.post('/admin/programs/:id/equipment/:eqId/delete', requireAdmin, async (req, res) => {
  await db.removeProgramEquipment(Number(req.params.eqId));
  res.redirect('/admin/programs/' + req.params.id + '/edit');
});

app.post('/admin/programs/:id/assign', requireAdmin, async (req, res) => {
  try {
    const playerIds = [].concat(req.body.player_ids || []).filter(Boolean).map(Number);
    const { start_date, end_date } = req.body;
    for (const pid of playerIds) {
      await db.assignProgram({ program_id: Number(req.params.id), player_id: pid, send_reminders: 1, start_date: start_date || null, end_date: end_date || null });
    }
    res.redirect('/admin/programs/' + req.params.id + '/edit?success=' + playerIds.length + '+players+assigned');
  } catch (err) {
    console.error('Program assign error:', err);
    res.redirect('/admin/programs/' + req.params.id + '/edit?error=' + encodeURIComponent(err.message));
  }
});

app.post('/admin/programs/:id/unassign/:playerId', requireAdmin, async (req, res) => {
  await db.unassignProgram(Number(req.params.id), Number(req.params.playerId));
  res.redirect('/admin/programs/' + req.params.id + '/edit');
});

app.post('/admin/programs/:id/set-all-dates', requireAdmin, async (req, res) => {
  try {
    const programId = Number(req.params.id);
    const { start_date, end_date } = req.body;
    await db.updateAllAssignmentDates(programId, start_date || null, end_date || null);
    res.redirect('/admin/programs/' + programId + '/edit?success=Dates+updated+for+all+assignments');
  } catch (err) {
    console.error('Set all dates error:', err);
    res.redirect('/admin/programs/' + req.params.id + '/edit?error=' + encodeURIComponent(err.message));
  }
});

app.post('/admin/programs/:id/assign-positions', requireAdmin, async (req, res) => {
  try {
    const programId = Number(req.params.id);
    const positions = [].concat(req.body.positions || []).filter(p => POSITIONS.includes(p));
    const { start_date, end_date } = req.body;
    await db.updateProgramPositions(programId, positions.join(','));
    const confirmedPlayers = await db.getConfirmedPlayers();
    let count = 0;
    for (const player of confirmedPlayers) {
      const posSource = player.coach_assigned_positions || player.best_positions;
      if (!posSource) continue;
      const playerPositions = posSource.split(',').map(p => p.trim()).filter(Boolean);
      if (playerPositions.some(pp => positions.includes(pp))) {
        await db.assignProgram({ program_id: programId, player_id: player.id, send_reminders: 1, start_date: start_date || null, end_date: end_date || null });
        count++;
      }
    }
    res.redirect('/admin/programs/' + programId + '/edit?success=Positions+saved,+' + count + '+players+matched');
  } catch (err) {
    console.error('Assign positions error:', err);
    res.redirect('/admin/programs/' + req.params.id + '/edit?error=' + encodeURIComponent(err.message));
  }
});

app.post('/admin/programs/:id/assign-all', requireAdmin, async (req, res) => {
  try {
    const programId = Number(req.params.id);
    const { start_date, end_date } = req.body;
    const confirmedPlayers = await db.getConfirmedPlayers();
    for (const player of confirmedPlayers) {
      await db.assignProgram({ program_id: programId, player_id: player.id, send_reminders: 1, start_date: start_date || null, end_date: end_date || null });
    }
    res.redirect('/admin/programs/' + programId + '/edit?success=All+' + confirmedPlayers.length + '+confirmed+players+assigned');
  } catch (err) {
    console.error('Assign all error:', err);
    res.redirect('/admin/programs/' + req.params.id + '/edit?error=' + encodeURIComponent(err.message));
  }
});

app.post('/programs/:id/complete-day', async (req, res) => {
  const programId = Number(req.params.id);
  const playerId = Number(req.body.player_id);
  const dayId = Number(req.body.day_id);
  const isAdmin = !!req.session.admin;
  if (!isAdmin && (!req.parentUser || !req.parentUser.player_ids.includes(playerId))) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const weekOf = getMonday(new Date());
  await db.markDayComplete(programId, playerId, dayId, weekOf);
  res.json({ success: true });
});

app.post('/programs/:id/uncomplete-day', async (req, res) => {
  const programId = Number(req.params.id);
  const playerId = Number(req.body.player_id);
  const dayId = Number(req.body.day_id);
  const isAdmin = !!req.session.admin;
  if (!isAdmin && (!req.parentUser || !req.parentUser.player_ids.includes(playerId))) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const weekOf = getMonday(new Date());
  await db.unmarkDayComplete(programId, playerId, dayId, weekOf);
  res.json({ success: true });
});

app.post('/programs/:id/set-dates', async (req, res) => {
  const programId = Number(req.params.id);
  const { player_id, phone, start_date, end_date } = req.body;
  const playerId = Number(player_id);
  await db.updateAssignmentDates(programId, playerId, start_date || null, end_date || null);
  res.redirect(`/profile/${playerId}?phone=${encodeURIComponent(phone || '')}#program-${programId}`);
});

app.get('/admin/programs/:id/dashboard', requireAdmin, async (req, res) => {
  const program = await db.getProgram(Number(req.params.id));
  if (!program) return res.redirect('/admin/programs');
  const days = await db.getProgramDays(program.id);
  for (const day of days) {
    day.activities = await db.getProgramActivities(day.id);
  }
  const assignments = await db.getProgramAssignments(program.id);
  // Week navigation
  const weekOffset = parseInt(req.query.week) || 0;
  const now = new Date();
  now.setDate(now.getDate() + weekOffset * 7);
  const weekOf = getMonday(now);
  const completions = await db.getCompletionsForWeek(program.id, weekOf);
  res.render('admin-program-dashboard', { program, days, assignments, completions, weekOf, weekOffset });
});

app.post('/admin/seed-arm-care', requireAdmin, async (req, res) => {
  try {
    const existing = (await db.getAllPrograms(req.teamId)).find(p => p.title === "Pitcher's Arm Care Program");
    if (existing) return res.redirect('/admin/programs?error=Arm+Care+program+already+exists');

    const program = await db.addProgram({
      title: "Pitcher's Arm Care Program",
      description: "How to bulletproof young pitcher's arms preventing injury while building velocity and control. A comprehensive weekly program covering arm care exercises, flexibility, throwing drills, and weighted ball velocity work.",
      author: "Coach Matt Thompson",
      program_type: 'at_home',
      schedule_type: 'weekly',
      published: 1,
      team_id: req.teamId
    });

    const days = [
      { label: 'Monday', activities: [
        { name: 'T-Flex: Stationary', reps: '30 sec', description: 'Arm Care', instructions: 'Stand tall, arms extended out in a "T," swing forward/backward for 30 seconds.' },
        { name: 'T-Flex: Walking', reps: '30 sec', description: 'Arm Care', instructions: 'Walk while maintaining "T" position, 30 seconds.' },
        { name: 'T-Flex: Carioca', reps: '30 sec', description: 'Arm Care', instructions: 'Perform a carioca while in "T" position, 30 seconds.' },
        { name: 'Arm Circles: Walking', reps: '30 sec', description: 'Arm Care', instructions: 'Arms out, circles forward/backward/mixed, 30 seconds.' },
        { name: 'Speed Towels', reps: '24-26 reps', description: 'Arm Care', instructions: 'Hold a hand towel and perform the pitching motion at full speed, aiming for a target ("stride plus five" steps away). Do 24-26 reps in 30 seconds. Use a regular towel or add a weighted baseball for added resistance.' },
        { name: 'Band Station', reps: '10 reps', description: 'Arm Care', instructions: 'Band mounted shoulder height, keep elbows shoulder height, grab the handles and walk back in a zombie pose with elbows at shoulder level until the slack is removed from the bands, drive the elbows straight back squeezing between the shoulder blades keeping the elbows at shoulder height. Maintain the elbow position and rotate up into a "field goal" pose. Then from there extend the arms into a "Y" pose, lower slowly back into zombie pose and repeat.' },
        { name: 'Weighted Ball Holds', reps: '3-5 per hand position', description: 'Build strength without throwing stress', instructions: 'Choose weighted ball (7-21 oz, never throw heavier ball during season—just hold). Grip, go through pitching motion, STOP at release (do not throw). 3-5 holds per hand position, focus on solid grip and smooth deceleration.\n\nNote: for 12U, stick to 11oz or less, only go above 11oz after puberty.' },
        { name: 'In and Outs', reps: '15', description: 'Flexibility', instructions: 'Swing arms across body and back (Hugs).' },
        { name: 'Arm Saws', reps: '15 each', description: 'Flexibility', instructions: 'Start with your arms extended out at shoulder height to the side (airplane wings) with your palms forward (thumbs up) and flap your arms forward and back like a bird horizontal to the ground, then do them with your palms to the sky for palms up, then switch for the last 15 to thumbs down, palms behind you.' },
        { name: 'Wrist Stretches', reps: '30 sec each position', description: 'Flexibility', instructions: 'Get down on all fours (knees and hands flat on the ground) with your fingers pointing straight up, rock forward until you feel the stretch, hold for 30. Rotate fingers so they are pointing to the sides, away from each other and rock side to side for 30 seconds. Then rotate once more until your fingers point to your knees and sit back towards your feet (deep stretch) hold for 30 seconds.' },
      ]},
      { label: 'Tuesday', activities: [
        { name: 'T-Flex: Stationary', reps: '30 sec', description: 'Arm Care', instructions: 'Stand tall, arms extended out in a "T," swing forward/backward for 30 seconds.' },
        { name: 'T-Flex: Walking', reps: '30 sec', description: 'Arm Care', instructions: 'Walk while maintaining "T" position, 30 seconds.' },
        { name: 'T-Flex: Carioca', reps: '30 sec', description: 'Arm Care', instructions: 'Perform a carioca while in "T" position, 30 seconds.' },
        { name: 'Arm Circles: Walking', reps: '30 sec', description: 'Arm Care', instructions: 'Arms out, circles forward/backward/mixed, 30 seconds.' },
        { name: 'Speed Towels', reps: '24-26 reps', description: 'Arm Care + Drill', instructions: 'Hold a hand towel and perform the pitching motion at full speed, aiming for a target ("stride plus five" steps away). Do 24-26 reps in 30 seconds. Use a regular towel or add a weighted baseball for added resistance.' },
        { name: 'Band Station', reps: '10 reps', description: 'Arm Care', instructions: 'Band mounted shoulder height, keep elbows shoulder height, grab the handles and walk back in a zombie pose with elbows at shoulder level until the slack is removed from the bands, drive the elbows straight back squeezing between the shoulder blades keeping the elbows at shoulder height. Maintain the elbow position and rotate up into a "field goal" pose. Then from there extend the arms into a "Y" pose, lower slowly back into zombie pose and repeat.' },
      ]},
      { label: 'Wednesday', activities: [
        { name: 'Jog Forwards and Backwards', reps: '30 sec each', description: 'Warm Up', instructions: 'Jog forwards for 30 seconds, then backwards for 30 seconds.' },
        { name: 'High Knee Skips', reps: '30 sec each direction', description: 'Warm Up', instructions: 'High knee skips, 30 seconds each direction.' },
        { name: 'Bounds with High Knees', reps: '30 sec each leg', description: 'Warm Up', instructions: 'Large strides with high knees, 30 seconds each leg.' },
        { name: 'Carioca (Grapevine)', reps: '30 sec each direction', description: 'Warm Up', instructions: 'Sideways shuffle/grapevine, 30 seconds each direction.' },
        { name: 'Tap & Go', reps: '30 sec', description: 'Warm Up', instructions: 'Lateral steps touching the ground with the opposite hand, 30 seconds.' },
        { name: 'Knee Drill', reps: '3-5 per hand position', description: 'Throwing Drill', instructions: '1. Kneel facing target, hips and knees aligned, glove in front.\n2. Twist your upper body as far as possible while keeping glove in front.\n3. Throw with max torque, finishing with glove out front.\n4. Repeat 3-5 reps per hand position for each ball type (regular or weighted).' },
        { name: 'Flat Ground Throws', reps: '10-15 per distance', description: 'Throwing Drill', instructions: '1. Play catch starting at 40-60 ft.\n2. Gradually extend distance: 90 ft, 120 ft, up to 130 ft. 90ft is plenty for 12U.\n3. Focus on flat trajectory, mechanics consistent with mound delivery.\n4. Stop increasing distance if mechanics break down—one-hop throws if needed.\n5. 10-15 throws per distance.' },
        { name: 'Long Toss', reps: '10 throws per phase', description: 'Throwing Drill', instructions: 'Medium Distance: Move back to 90 feet, increase intent but maintain smooth mechanics, make 10 throws focusing on accuracy and posture.\n\nMaximum Distance: Progress out to 120-130 feet, deliver firm throws keeping a flat trajectory ("throw on a line," not an arc), complete up to 10 throws. If form breaks down, reduce distance or switch to one-hop throws.\n\nReturn-In: Gradually move closer after reaching max distance, maintain effort and consistency of mechanics, finish with 10 throws decreasing back to short toss.\n\nCoaching Keys: Emphasize repeating mound mechanics for every throw—do not sacrifice form for distance. Stop increasing distance once mechanics falter.' },
      ]},
      { label: 'Thursday', activities: [
        { name: 'T-Flex: Stationary', reps: '30 sec', description: 'Arm Care', instructions: 'Stand tall, arms extended out in a "T," swing forward/backward for 30 seconds.' },
        { name: 'T-Flex: Walking', reps: '30 sec', description: 'Arm Care', instructions: 'Walk while maintaining "T" position, 30 seconds.' },
        { name: 'T-Flex: Carioca', reps: '30 sec', description: 'Arm Care', instructions: 'Perform a carioca while in "T" position, 30 seconds.' },
        { name: 'Arm Circles: Walking', reps: '30 sec', description: 'Arm Care', instructions: 'Arms out, circles forward/backward/mixed, 30 seconds.' },
        { name: 'Speed Towels', reps: '24-26 reps', description: 'Arm Care', instructions: 'Hold a hand towel and perform the pitching motion at full speed, aiming for a target ("stride plus five" steps away). Do 24-26 reps in 30 seconds.' },
        { name: 'Band Station', reps: '10 reps', description: 'Arm Care', instructions: 'Band mounted shoulder height, keep elbows shoulder height, grab the handles and walk back in a zombie pose with elbows at shoulder level until the slack is removed from the bands, drive the elbows straight back squeezing between the shoulder blades keeping the elbows at shoulder height. Maintain the elbow position and rotate up into a "field goal" pose. Then from there extend the arms into a "Y" pose, lower slowly back into zombie pose and repeat.' },
        { name: 'Weighted Ball Holds', reps: '3-5 per hand position', description: 'Build strength without throwing stress', instructions: 'Choose weighted ball (7-21 oz, never throw heavier ball during season—just hold). Grip, go through pitching motion, STOP at release (do not throw). 3-5 holds per hand position, focus on solid grip and smooth deceleration.\n\nNote: for 12U, stick to 11oz or less, only go above 11oz after puberty.' },
        { name: 'In and Outs', reps: '15', description: 'Flexibility', instructions: 'Swing arms across body and back (Hugs).' },
        { name: 'Arm Saws', reps: '15 each', description: 'Flexibility', instructions: 'Start with your arms extended out at shoulder height to the side (airplane wings) with your palms forward (thumbs up) and flap your arms forward and back like a bird horizontal to the ground, then do them with your palms to the sky for palms up, then switch for the last 15 to thumbs down, palms behind you.' },
        { name: 'Wrist Stretches', reps: '30 sec each position', description: 'Flexibility', instructions: 'Get down on all fours with your fingers pointing straight up, rock forward until you feel the stretch, hold for 30. Rotate fingers pointing to the sides and rock side to side for 30 seconds. Rotate once more until fingers point to your knees and sit back towards your feet (deep stretch), hold for 30 seconds.' },
      ]},
      { label: 'Friday', activities: [
        { name: 'Jog Forwards and Backwards', reps: '30 sec each', description: 'Warm Up', instructions: 'Jog forwards for 30 seconds, then backwards for 30 seconds.' },
        { name: 'High Knee Skips', reps: '30 sec each direction', description: 'Warm Up', instructions: 'High knee skips, 30 seconds each direction.' },
        { name: 'Bounds with High Knees', reps: '30 sec each leg', description: 'Warm Up', instructions: 'Large strides with high knees, 30 seconds each leg.' },
        { name: 'Carioca (Grapevine)', reps: '30 sec each direction', description: 'Warm Up', instructions: 'Sideways shuffle/grapevine, 30 seconds each direction.' },
        { name: 'Tap & Go', reps: '30 sec', description: 'Warm Up', instructions: 'Lateral steps touching the ground with the opposite hand, 30 seconds.' },
        { name: 'Rocker Drill', reps: '3-5 per hand position', description: 'Throwing Drill', instructions: '1. Stand with stride foot forward and landing knee bent at 90 degrees.\n2. Keep back leg on ground, rock torso gently back and forth.\n3. After max load, throw to target—glove stays out front.\n4. Repeat 3-5 reps per hand position.' },
        { name: 'Crow-Hop (Run and Gun)', reps: '3-5 per hand position', description: 'Throwing Drill', instructions: '1. Cross back foot behind lead foot, hop forward to drive off rear leg.\n2. Use body momentum to throw on a straight line with max effort.\n3. Always finish with glove in front.\n4. Repeat 3-5 reps per hand position.' },
        { name: 'Flat Ground Throws', reps: '10-15 per distance', description: 'Throwing Drill', instructions: '1. Play catch starting at 40-60 ft.\n2. Gradually extend distance: 90 ft, 120 ft, up to 130 ft. 90ft is plenty for 12U.\n3. Focus on flat trajectory, mechanics consistent with mound delivery.\n4. Stop increasing distance if mechanics break down—one-hop throws if needed.\n5. 10-15 throws per distance.' },
      ]},
      { label: 'Saturday', activities: [
        { name: 'Jog Forwards and Backwards', reps: '30 sec each', description: 'Warm Up', instructions: 'Jog forwards for 30 seconds, then backwards for 30 seconds.' },
        { name: 'High Knee Skips', reps: '30 sec each direction', description: 'Warm Up', instructions: 'High knee skips, 30 seconds each direction.' },
        { name: 'Bounds with High Knees', reps: '30 sec each leg', description: 'Warm Up', instructions: 'Large strides with high knees, 30 seconds each leg.' },
        { name: 'Carioca (Grapevine)', reps: '30 sec each direction', description: 'Warm Up', instructions: 'Sideways shuffle/grapevine, 30 seconds each direction.' },
        { name: 'Tap & Go', reps: '30 sec', description: 'Warm Up', instructions: 'Lateral steps touching the ground with the opposite hand, 30 seconds.' },
        { name: 'T-Flex Walks + Arm Circles', reps: '30 sec each', description: 'Arm Care Warm Up', instructions: 'T-Flex walks and arm circles to prepare the arm for velocity work.' },
        { name: 'Speed Towels', reps: '24 reps in 30 sec', description: 'Arm Care Warm Up', instructions: 'Speed towel drill at full intent to complete arm warm-up before weighted ball work.' },
        { name: 'Weighted Ball Velocity: Knee Drill', reps: '3 holds + 2 throws per weight/position', description: 'Weighted Ball Velocity (INTENSE)', instructions: 'For each ball weight, use 3 hand positions—palm forward (FB), in (CB), out (CH).\n\n1. Kneel facing target, hips and knees aligned.\n2. Hold weighted ball, glove in front.\n3. Twist upper body to load, then throw with full intent (max torque), glove stays in front.\n4. Do 3 "holds" (go through motion but do NOT release ball), then 2 actual throws per ball weight and hand position.\n\nEquipment: 2oz, 4oz, 5oz (standard), 7oz, 9oz, 11oz. Stop at 11oz for 12U.' },
        { name: 'Weighted Ball Velocity: Rocker Drill', reps: '3 holds + 2 throws per weight/position', description: 'Weighted Ball Velocity (INTENSE)', instructions: '1. Stand in stride stance, landing knee bent 90 degrees, back leg anchored.\n2. Rock torso gently forward and back, loading hips.\n3. At max load, throw to target focusing on mechanics.\n4. Repeat 3 "holds" then 2 throws per ball weight and hand position.' },
        { name: 'Weighted Ball Velocity: Step-Behind', reps: '2 holds + 3 throws per weight/position', description: 'Weighted Ball Velocity (INTENSE)', instructions: '1. Stand next to plate, step behind with rear leg to load.\n2. Follow through, rotate hips then shoulders, throw toward target.\n3. Always finish tall and glove stays out front.\n4. 2 holds, 3 throws each per weight and hand position.\n\nProgress to this drill after building basics with Knee and Rocker drills.' },
        { name: 'Weighted Ball Velocity: Crow-Hop', reps: '2 holds + 3 throws per weight/position', description: 'Weighted Ball Velocity (INTENSE)', instructions: '1. Cross back foot behind and hop to generate momentum.\n2. Throw with max intent; use only light & regular weights.\n3. 2 holds, 3 throws per ball/hand position once mechanics are consistent.\n\nTotal throws and holds should rarely exceed 40 per session; stop when mechanics break down or fatigue sets in.' },
        { name: 'Post-Throwing Arm Care', reps: '5-10 min', description: 'Recovery', instructions: 'Light jogging: 5 minutes\nArm stretches (shoulder/elbow): 15-30 seconds each\nIce if performing max effort throws or weighted balls heavier than 7 oz\nHydrate and focus on post-throw nutrition' },
      ]},
      { label: 'Sunday', activities: [
        { name: 'Jog Forwards and Backwards', reps: '30 sec each', description: 'Warm Up', instructions: 'Jog forwards for 30 seconds, then backwards for 30 seconds.' },
        { name: 'High Knee Skips', reps: '30 sec each direction', description: 'Warm Up', instructions: 'High knee skips, 30 seconds each direction.' },
        { name: 'Bounds with High Knees', reps: '30 sec each leg', description: 'Warm Up', instructions: 'Large strides with high knees, 30 seconds each leg.' },
        { name: 'Carioca (Grapevine)', reps: '30 sec each direction', description: 'Warm Up', instructions: 'Sideways shuffle/grapevine, 30 seconds each direction.' },
        { name: 'Tap & Go', reps: '30 sec', description: 'Warm Up', instructions: 'Lateral steps touching the ground with the opposite hand, 30 seconds.' },
        { name: 'Flat Ground Throws', reps: '10-15 per distance', description: 'Throwing Drill', instructions: '1. Play catch starting at 40-60 ft.\n2. Gradually extend distance: 90 ft, 120 ft, up to 130 ft. 90ft is plenty for 12U.\n3. Focus on flat trajectory, mechanics consistent with mound delivery.\n4. Stop increasing distance if mechanics break down—one-hop throws if needed.\n5. 10-15 throws per distance.' },
        { name: 'Long Toss', reps: '10 throws per phase', description: 'Throwing Drill', instructions: 'Medium Distance: Move back to 90 feet, increase intent but maintain smooth mechanics, make 10 throws focusing on accuracy and posture.\n\nMaximum Distance: Progress out to 120-130 feet, deliver firm throws keeping a flat trajectory, complete up to 10 throws. If form breaks down, reduce distance or switch to one-hop throws.\n\nReturn-In: Gradually move closer after reaching max distance, maintain effort and consistency of mechanics, finish with 10 throws decreasing back to short toss.' },
      ]},
    ];

    for (let i = 0; i < days.length; i++) {
      const day = await db.addProgramDay({ program_id: program.id, day_label: days[i].label, day_number: i, sort_order: i });
      for (let j = 0; j < days[i].activities.length; j++) {
        const a = days[i].activities[j];
        await db.addProgramActivity({ program_day_id: day.id, activity_name: a.name, description: a.description, instructions: a.instructions, reps: a.reps, sort_order: j });
      }
    }
    res.redirect('/admin/programs/' + program.id + '/edit?success=Arm+Care+program+seeded');
  } catch (err) {
    console.error('Seed error:', err);
    res.redirect('/admin/programs?error=' + encodeURIComponent(err.message));
  }
});

app.post('/admin/seed-perry-hill', requireAdmin, async (req, res) => {
  try {
    const programs = [
      {
        title: 'Perry Hill: Infield Fundamentals - The Six Fs',
        description: 'The foundation of Perry Hill\'s infield system. Every infielder must master the Six Fs: Feet, Field, Funnel, Footwork, Fire, and Follow.',
        positions: '1B,2B,SS,3B',
        days: [
          { label: 'F1: Feet - Ready Position', activities: [
            { name: 'Relaxed Stance', description: 'Be in a relaxed position as the pitcher holds the ball. Stay loose and athletic.', instructions: 'Stand at your position with knees slightly bent, weight balanced.', reps: 'Every pitch' },
            { name: 'Bend on First Movement', description: 'On the pitcher\'s first movement, bend your back slightly to begin loading.', instructions: 'Watch the pitcher\'s arm. As it starts moving forward, begin your bend.', reps: 'Every pitch' },
            { name: 'Small Step & Separate', description: 'When the pitcher\'s arm reaches the ear, take a small step forward with either foot, then separate feet to shoulder-width apart.', instructions: 'Step forward, then separate both feet simultaneously so weight is distributed evenly on the balls of your feet. Knees slightly bent.', reps: '10 reps dry, then live off fungo' },
            { name: 'Avoid Laziness', description: 'Always move your feet into the proper position - wide base, butt down, hands out front.', instructions: 'Set up with a wide base, the butt down, and the hands out in front on every single pitch. Never get lazy as the game progresses.', reps: 'Every pitch' },
          ]},
          { label: 'F2: Field - Get to the Ball', activities: [
            { name: 'Wide Base Setup', description: 'As you get to the ball, make sure your feet are wide apart to create a wide base.', instructions: 'Get to the ball as quickly as you can. Set up with feet wide apart so your butt can get down and hands can push out front.', reps: '10 ground balls' },
            { name: 'See Ball and Glove Together', description: 'Field the ball out in front so you can see the ball and the glove in the same view.', instructions: 'Watch the ball from the bat into the glove. Seeing both together makes you a more consistent fielder and helps you react to difficult hops.', reps: '10 ground balls' },
            { name: 'Balance Point', description: 'A wide base provides a good balance point so you won\'t tip over.', instructions: 'Create a wide base. Not creating one will cause your glove to lift off the ground and may tip you forward. A narrow stance makes it hard to see ball and glove together.', reps: '10 ground balls' },
          ]},
          { label: 'F3: Funnel - Soft Hands', activities: [
            { name: 'Funnel to Body Center', description: 'After fielding the ball out in front, funnel the ball back into your body with soft hands.', instructions: 'Catch the ball, then bring it to the center of the body at chest level so you can separate the hands and prepare to throw.', reps: '10 ground balls' },
            { name: 'Thumbs Down Separation', description: 'Separate the hands with the thumbs down to get into a position of power.', instructions: 'Thumbs down locks your front shoulder on target and ensures proper elbow angle with hand above the ball. This leads to a more powerful, accurate throw.', reps: '10 reps dry, 10 with ball' },
          ]},
          { label: 'F4: Footwork - Direction & Momentum', activities: [
            { name: 'Right-Left-Target (RH throwers)', description: 'The formula is right foot to left foot and left foot to target. For lefties: left to right and right to target.', instructions: 'Move your feet in the direction of the target without crossing over. Right-handers take the right foot toward the left, then the left toward the target.', reps: '10 reps dry' },
            { name: 'No Cross-Over Rule', description: 'Never cross your feet before releasing the ball - it causes your hand to get under the ball and strains the elbow.', instructions: 'If you cross over your feet, the ball can move during flight. Keep feet moving toward target, never crossing.', reps: '10 throws focusing on footwork' },
          ]},
          { label: 'F5: Fire - Release the Ball', activities: [
            { name: 'Quick Release', description: 'If the first four Fs are completed, you shouldn\'t have to think about anything other than getting rid of the ball quickly.', instructions: 'Thumbs-down separation should have your front shoulder aligned and elbow at proper angle with hand behind ball. Release with confidence.', reps: '10 throws' },
            { name: 'Four-Seam Grip', description: 'Always use a four-seam grip when throwing after the catch.', instructions: 'Grip across the seams for maximum rotation and accuracy. Keep your elbow above the shoulder.', reps: 'Every throw' },
          ]},
          { label: 'F6: Follow - Follow the Throw', activities: [
            { name: 'Follow Through', description: 'After releasing the ball, your body should automatically follow toward the target for several steps.', instructions: 'If you\'re peeling off or not following through, it means you\'re not generating enough momentum. Go back and check the first five Fs.', reps: '10 throws with follow' },
            { name: 'Complete Six Fs Drill', description: 'Put all six Fs together: Relax, Bend, Step, Separate, Field, Wide Base, Funnel, Footwork, Thumbs Down, Fire, Follow.', instructions: 'Full sequence from ready position through follow-through. Every rep should hit all six Fs in order.', reps: '20 ground balls' },
          ]},
        ],
      },
      {
        title: 'Perry Hill: First Baseman Program',
        description: 'Complete first baseman development program covering break to base, receiving throws, ground balls, bunts, holding runners, and pick-offs from the Perry Hill system.',
        positions: '1B',
        days: [
          { label: 'Break to Base & Receiving', activities: [
            { name: 'Anchor at Corner', description: 'Right-handed 1B: Go to the corner closest with left foot, replace with right foot. See throw, drop foot, stretch foot to the ball.', instructions: 'Anchor at the corner away from the glove. See the throw, drop the foot, stretch to the ball.', reps: '10 reps each side' },
            { name: 'Fungo Drill', description: 'Ground balls from various infield spots to keep 1B from stretching too early. Receive simulated low throws "inside" and stretch whether forehand or backhand.', instructions: 'Right-handed 1B: Backhand any ball at or outside left shoulder, forehand any ball inside left shoulder. Left-handed 1B: Backhand at or inside right shoulder, forehand outside right shoulder.', reps: '15 throws' },
            { name: 'Decision-Making Drill', description: 'Come off the bag on the outfield side to save an errant throw. Roll with the tag on wide throws "up the line."', instructions: 'Simulate balls in front of the mound or home plate with left foot against inside part of bag. Receive good throws. Work on shifting feet into foul territory on errant throws outside the line.', reps: '10 reps' },
          ]},
          { label: 'Ground Balls at First Base', activities: [
            { name: 'Ground Balls - Throws to Second', description: 'Rolled, fungo, or soft toss with throws to second base. Emphasis on good fielding position, footwork, and throwing mechanics.', instructions: 'Direction of ball determines fielding position and footwork. Right-handed 1B at first base: right foot to left, left to second. Toward the line: field right foot to left, left foot to second.', reps: '15 ground balls' },
            { name: 'Ground Balls - Pitcher Covering', description: 'Rolled, fungo, soft toss with pitcher covering first. Field and follow with "no spin" toss.', instructions: 'At or medium speed away: Field and follow with no-spin toss. Hard to backhand routine: Field in middle of body, in front of throwing side foot, stay low, throw uphill. Extended: Field off glove side foot, gather balance as throwing side foot crosses over, stay low, throw uphill.', reps: '10 each type' },
          ]},
          { label: 'Bunts', activities: [
            { name: 'Bunts - Runner on First', description: 'Set angle on "early break." Must "get around" all bunts with proper footwork.', instructions: 'Right-handed 1B Forehand: field mid-body to right foot, jab step with left foot to second or right foot to left, left to second or first. Left-handed 1B Forehand: field mid-body to left foot, jab step with right foot to second or left foot to right, right to second or first.', reps: '10 bunts' },
            { name: 'Bunts - Runners on First and Second', description: 'In on grass charging in a straight line to home plate. Direction of bunt determines fielding position. Field with lead base in mind.', instructions: 'Right-handed 1B: Ball left of body mid-line forehand, field inside left foot, right foot to left foot, left foot reverse pivot to third base. Ball right of body mid-line backhand: field ball inside left foot, right foot to left, left foot to first, third base.', reps: '10 bunts' },
            { name: 'Tweeners', description: 'Read speed and direction of ball to decide coverage.', instructions: 'Soft: Cover first. Hard: 3-1 play (throw to third, cover first).', reps: '5 each type' },
          ]},
          { label: 'Holding Runners & Pick-Offs', activities: [
            { name: 'Proper Set-Up for Holding Runners', description: 'Right foot against the base, inside edge with toes extending beyond front inside corner. Left foot should be "open" with heel against foul line pointed to mound area.', instructions: 'Position ensures tag is in front of base. Stay in fair territory. Left heel against foul line.', reps: '10 reps' },
            { name: 'Receive Pick-Off Throws', description: 'Make hard, straight downward tag. Simulate runners on first-and-third with "blind" tag technique.', instructions: 'On first-and-third: receive pick-off throw, keep head up, watch runner at third while making the tag.', reps: '10 pick-off tags' },
            { name: 'Break Off Bag with Pitch', description: 'Lead with right foot, shuffle back staying "square" to home plate for possible pickoff throw from catcher.', instructions: 'Drop step (Right-hander: left foot; Left-hander: right foot). Reverse tag; catch or block errant throws.', reps: '5 reps each' },
            { name: 'First Move with Left-Handed Pitcher', description: 'Proper footwork creates angle and distance to second base when runner breaks.', instructions: 'Right-handed 1B: move right foot to left foot, then left foot to second base. Pick-off throw should be on outside left shoulder. Left-handed 1B: right foot to pick-off throw, left foot to right foot, right foot to second.', reps: '5 reps' },
          ]},
        ],
      },
      {
        title: 'Perry Hill: Second Baseman Program',
        description: 'Complete second baseman development: positioning, ground balls, slow rollers, backhands, and double play pivots from the Perry Hill infield system.',
        positions: '2B',
        days: [
          { label: 'Positioning & Routine Ground Balls', activities: [
            { name: 'Positioning Strategy', description: 'Move with the count and game situation. Understand when to shade and when to play straight up.', instructions: 'Adjust based on pitcher, hitter tendencies, count, and base runners. Know your pitcher\'s strengths.', reps: 'Situational review' },
            { name: 'Routine Ground Balls to First', description: 'Rolled, fungo, soft toss with throws to first base. Emphasis on good fielding position, footwork (replace) and throwing mechanics.', instructions: 'Field the ball, use replace footwork (right-left to target), throw to first with four-seam grip.', reps: '15 ground balls' },
            { name: 'Slow Rollers', description: 'Using proper angle, field ball slightly outside left foot. Make change "in the middle" and throw off the right foot.', instructions: 'Field left, throw right. If ball is fielded on the grass, tuck glove into body to enable arm to get "back and through" to first baseman.', reps: '10 slow rollers' },
          ]},
          { label: 'Backhand & Varied Ground Balls', activities: [
            { name: 'Backhand - Routine', description: 'Using proper angle, take right foot to the ball, extend glove in front of right foot in middle of body. Left shoulder automatically at first base.', instructions: 'Use replace footwork: right to left, left to first or take a jab step toward first with left foot.', reps: '10 backhands' },
            { name: 'Backhand - Extended', description: 'Using proper angle, field ball off left foot, gather balance as right foot crosses over and plants.', instructions: 'Take a jab step toward first base with left foot after planting.', reps: '10 extended backhands' },
            { name: 'Medium Speed Ground Balls', description: 'Various speeds and angles. Player chooses correct approach and footwork.', instructions: 'Medium speed to right, below average runner: get around the ball, field slightly outside left foot making exchange "in the middle", use right-left replace footwork. With average or above average runner: get around ball, exchange "in the middle" and throw off right foot. Field left, throw right.', reps: '15 varied ground balls' },
          ]},
          { label: 'DP Pivots from SS/3B', activities: [
            { name: 'Middle Back Position', description: 'Approach the base with hands up and in, shoulders parallel to third base line. Left foot on or near middle of base, right foot extended behind the bag.', instructions: 'This is the "middle back" starting position for receiving throws from the shortstop or third baseman.', reps: '5 dry reps' },
            { name: 'Throw Between Shoulders', description: 'Receive the throw, left foot takes a jab step to first base, make the relay throw.', instructions: 'Quick transfer from glove to hand, jab step toward first, fire.', reps: '10 feeds' },
            { name: 'Slow Hit Ball / Backhand Feed', description: 'Step to the ball with right foot and as the left foot comes down, make the relay throw.', instructions: 'Adjust footwork to the speed and location of the feed.', reps: '10 feeds' },
            { name: 'Behind Right Shoulder', description: 'Step to the ball with right foot, drag left across the bag, left foot takes a jab step to first base and make the relay throw.', instructions: 'Stay athletic, keep hands up and ready.', reps: '10 feeds' },
            { name: 'In Front of Left Shoulder', description: 'Step to the ball with right foot as left foot comes down and make the relay throw.', instructions: 'Catch and throw in one motion, using momentum toward first base.', reps: '10 feeds' },
          ]},
          { label: 'DP Pivots from 1B/Pitcher & Feeds', activities: [
            { name: 'Pivot from First Baseman', description: 'Ground ball inside the baseline. Approach bag with shoulders "square" to first baseman. Left foot on or near back outside corner with right foot extending inside baseline.', instructions: 'From left shoulder in: right foot jab step, drag left foot across base, make relay. Outside left shoulder: left foot jab step, begin right-left footwork to first.', reps: '10 feeds each type' },
            { name: 'Pivot from Pitcher', description: 'Approach bag with right foot slightly past the back corner of second base.', instructions: 'From right shoulder in: left foot to ball, right to left, left to first base footwork. From right shoulder out: right foot to ball, drag left foot across bag, jab step to first.', reps: '10 feeds each type' },
            { name: 'DP Feeds to Shortstop', description: 'Five types based on "straight up" depth and ball location.', instructions: '1) Ground ball toward 2B or directly at 2B: no spin underhand toss. 2) Ground ball fielded behind bag: no spin backhand toss. 3) Ground ball to right fielded "in the middle": left foot slightly open, firm uphill throw to back of 2B. 4) Below avg runner, medium speed toward 1B: funnel, replace feet, strong throw to back of 2B. 5) Hard ground ball first base hole, below avg runner at first: field off left foot, back to infield, strong throw to back of 2B.', reps: '3 each type' },
            { name: 'Closed Eye Pivots', description: 'Ball in hand, simulate receiving throws with eyes closed. Use appropriate pivot and make the relay throw.', instructions: 'This is a fundamentals check. Close eyes, feel the throw, open and execute proper footwork and throw.', reps: '10 reps' },
          ]},
        ],
      },
      {
        title: 'Perry Hill: Shortstop Program',
        description: 'Complete shortstop development: double play pivots from 1B, 2B, and pitcher, DP feeds, and closed eye drill from the Perry Hill infield system.',
        positions: 'SS',
        days: [
          { label: 'DP Pivots from 1B & 2B', activities: [
            { name: 'Setup Position', description: 'Approach the bag with shoulders "square" to the infielder. Right foot on or near back inside corner of base, left foot extending behind the bag.', instructions: 'Hands up and in. Be ready to adjust to the throw location.', reps: '5 dry reps' },
            { name: 'Throw Between Shoulders', description: 'With left foot, take a jab step to the ball, then use right to left, left to first base footwork. Make the relay throw.', instructions: 'Replace the feet - right foot changes sides, left foot follows toward first.', reps: '10 feeds' },
            { name: 'From Right Shoulder Out', description: 'With the left foot, take a jab step to the ball, then use right to left, left to first base footwork. Make the relay throw.', instructions: 'Same replace footwork, adjusting angle for the feed location.', reps: '10 feeds' },
            { name: 'Inside Right Shoulder', description: 'With right foot, take a jab step to the ball, drag left foot across the base creating a jab step to first base, make the relay throw.', instructions: 'Quick feet across the bag, staying low for the throw.', reps: '10 feeds' },
          ]},
          { label: 'DP Pivots from 1B & Pitcher', activities: [
            { name: 'Pivots from First Baseman', description: 'Ground ball inside the baseline. Approach with shoulders "square" to first baseman. Left foot on or near back outside corner, right foot extending inside baseline.', instructions: 'From left shoulder in: right foot jab step, drag left foot across base, relay throw. Outside left shoulder: left foot jab step, begin right-left to first base footwork.', reps: '10 feeds each type' },
            { name: 'Pivot from Pitcher', description: 'Approach bag with left foot slightly past back corner of second base.', instructions: 'From right shoulder in: left foot to ball, use right to left, left to first base footwork. From right shoulder out: right foot to ball, drag left foot across bag, jab step to first.', reps: '10 feeds each type' },
          ]},
          { label: 'DP Feeds & Closed Eye Drill', activities: [
            { name: 'DP Feeds to Second Baseman', description: 'Five types based on "straight up" depth and ball location.', instructions: '1) Ground ball toward 2B or directly at SS: no spin underhand toss. 2) Ground ball fielded behind bag: no spin backhand toss. 3) Ground ball to right which can be fielded "in the middle": left foot slightly open, firm uphill throw to back of 2B. 4) Hard ground ball to right, routine or extended backhand: deliver a strong throw to back of 2B. 5) Medium speed ground ball to right, below avg runner at first: using proper angle, field off left foot, exchange "in the middle", throw back to 2B to get lead runner.', reps: '3 each type' },
            { name: 'Closed Eye Pivots', description: 'Ball in hand, simulate receiving throws with eyes closed. Use appropriate pivot and make the relay throw.', instructions: 'This is a fundamentals check. Build muscle memory for pivot footwork.', reps: '10 reps' },
          ]},
        ],
      },
      {
        title: 'Perry Hill: Third Baseman Program',
        description: 'Complete third baseman development: routine ground balls, slow rollers, backhands, bunts, bunt reads, and varied ground ball situations from the Perry Hill system.',
        positions: '3B',
        days: [
          { label: 'Routine Ground Balls & Slow Rollers', activities: [
            { name: 'Routine Ground Balls', description: 'Rolled, fungo, soft toss with throws to first or second base. Emphasis on good fielding position, footwork (replace) and throwing mechanics.', instructions: 'Field the ball with wide base, funnel to body, use replace footwork to target. Right to left, left to first or second base.', reps: '15 ground balls' },
            { name: 'Slow Rollers', description: 'Rolled, fungo, soft toss with throws to first base. Using proper angle, field ball slightly outside left foot.', instructions: 'Make exchange "in the middle" and throw off right foot. Field left, throw right.', reps: '10 slow rollers' },
          ]},
          { label: 'Backhand & Varied Ground Balls', activities: [
            { name: 'Backhand - Routine', description: 'Using proper angle, take right foot to the ball, extend glove in front of right foot in middle of body. Left shoulder automatically at target.', instructions: 'Use replace footwork: right to left, left to first base or take a jab step forward first or second with left foot.', reps: '10 backhands' },
            { name: 'Backhand - Extended', description: 'Using proper angle, field ball off left foot, gather balance as your right foot crosses over and plants.', instructions: 'Take a jab step toward target with left foot.', reps: '10 extended backhands' },
            { name: 'Varied Ground Balls', description: 'Various speeds, angles, and situations. Player chooses correct approach and footwork.', instructions: '1) Medium speed to right, below avg runner: get around ball, field outside left foot, replace footwork. 2) Same with avg/above avg runner: exchange "in the middle", throw off right foot. 3) Hard ground ball to right: backhand routine and/or extended. 4) Hard or medium at or left: field ball in middle of body, replace footwork. 5) Hard ball directly at player with no momentum: use left, replace footwork.', reps: '15 varied ground balls' },
          ]},
          { label: 'Bunt Plays & Reads', activities: [
            { name: 'Bunt Plays', description: 'Simulate: field bunt with lead base in mind, make adjustment to first base if called.', instructions: 'Charge the ball, read the direction and speed. Field slightly outside glove side foot, make the exchange "in the middle", throw off the right foot. Field left, throw right.', reps: '10 bunts' },
            { name: 'Read Bunts', description: 'Position even with bag or "in." Read hitter\'s hand as it slides up the bat or as he uses a drop step.', instructions: 'Take a quick, aggressive first step to the middle of the line. Second step with left foot toward home plate. These two steps give correct angle, distance, and momentum through the ball with minimal steps.', reps: '10 bunt reads' },
            { name: 'Situation: Runners on 1st and 2nd', description: 'Read ground ball, at or toward second base. After fielding, get ball "out" and ready to throw with right foot touch inside front corner of third base.', instructions: '5U-3 play: After fielding ball, get the ball out, right foot touch inside front corner of 3B, then replace feet and make relay throw to first base.', reps: '10 situational reps' },
          ]},
        ],
      },
      {
        title: 'Perry Hill: Game Situations & Movement',
        description: 'Where every position goes in every game scenario: bunt defenses, squeeze plays, first-and-third defense, pick-offs, relays, cut-offs, and defensive positioning.',
        positions: 'P,C,1B,2B,3B,SS,LF,CF,RF',
        days: [
          { label: 'Bunt Defense - No Set Play', activities: [
            { name: 'Runner on First - No Set Play', description: 'Primary objective: get the out. Secondary: get the lead runner.', instructions: '3B: In on grass, creeping, charges toward home when pitcher delivers. Hustles back to cover 3B if he doesn\'t field it. SS: At DP depth, covers 2B. 2B: At DP depth, creeps in, reads bunt, then covers 1B. 1B: Holds runner then charges when pitcher delivers. Covers foul line to mound area. P: Delivers strike then breaks toward home plate. C: Calls play loud and clear. Fields all bunts close to home plate. Also covers 3B if 3B fields the ball.', reps: '5 walk-throughs, 5 live' },
          ]},
          { label: 'Bunt Situations #1 - #4', activities: [
            { name: 'Bunt Situation #1 - Set Up Play #2', description: 'Runner on first. Primary objective: set up play #2. Secondary: keep runner honest.', instructions: '3B: Holds position, backs up returning throw to pitcher from 1B. SS: At DP depth, on pickoff throw to 1B breaks toward 2B. 2B: Breaks back at angle to protect against bad pickoff throw. 1B: Receives sign from manager, goes to mound, tells pitcher to throw over. Holding runner on, receives pickoff throw. P: Verbally receives sign from 1B, comes set, holds ball, makes pickoff throw to 1B. C: Set up as usual.', reps: '5 walk-throughs' },
            { name: 'Bunt Situation #2 - Get Out at Second', description: 'Runner on first. Primary objective: get out at second base.', instructions: '3B: In on grass, creeping. Charges toward home plate when pitcher delivers or reads bunt. Hustles back to cover 3B if he doesn\'t field it. SS: At DP depth, covers 2B. 2B: At DP depth, creeps in and reads bunt, then covers 1B. 1B: Receives sign from manager, goes to mound, tells pitcher "Do not throw over. When I break early, deliver a strike." Charges hard but under control. Perfect bunt = get the out at 1B. P: Delivers a strike then breaks towards home plate. C: Calls play loud and clear. Fields all bunts close to home plate. Covers 3B if 3B fields ball.', reps: '5 walk-throughs' },
            { name: 'Bunt Situation #3 - Keep Runner Honest', description: 'Runner on first. Primary objective: keep the runner honest.', instructions: '3B: Holds position. SS: At DP depth, on pickoff throw to 1B breaks toward 2B. 2B: At DP depth, breaks back at angle to protect against bad pickoff throw. 1B: Goes to mound, tells pitcher to wait for his false break. Takes two hard steps toward home, retreats to 1B, receives pickoff throw. P: Verbally receives sign from 1B, comes set as 1B retreats, makes pickoff throw to 1B. C: Set up as usual.', reps: '5 walk-throughs' },
            { name: 'Bunt Situation #4 - Inside Move', description: 'Runners on first-and-second, 0-out. Possible bunt/hit & run. Primary objective: reduce base runner aggression.', instructions: '3B: Slight body angle facing pitcher, ready for rundown or play at 3B. SS: A little deeper than DP depth, at peak of pitcher\'s leg lift breaks to 2B. 2B: A little deeper than DP depth, does not give play away, creeps in, ready to cover 2B for possible rundown. 1B: One or two steps in on grass as decoy, when pitcher\'s leg lifts breaks hard toward home. P: Will come set locked on home plate. At peak of leg lift, pivots on post foot and delivers firm chest-high throw to 2B. Then breaks in controlled jog toward 3B for possible rundown.', reps: '5 walk-throughs' },
          ]},
          { label: 'Bunt Defense #1 Regular (1st & 2nd)', activities: [
            { name: '#1 Regular - Runners on 1st & 2nd', description: 'Obvious or probable bunt in order, 0-out. Be ready for batted ball but play shallow enough to field a bunt.', instructions: '3B: Receives and gives sign. Position just inside line about 3-4 steps in front of bag. Slight body angle facing pitcher but will "square up" to home plate with the pitch. Can also play 1-2 steps behind bag on soft bunts. Takes charge on hard bunts toward him and calls off pitcher. SS: At DP depth, keeps runner close to 2B, "daylight" pick-off play possible, covers 2B. 2B: At DP depth, reads bunt, breaks in, then covers 1B. 1B: On edge of grass (can also play behind runner). Reads bunt and charges to cover area between foul line and mound. Also takes bunts up the middle. P: Holds runner at 2B (possible daylight play with SS). Delivers strike, reads bunt, breaks off mound to 3B side. Will yield to 3B if he calls for the ball. C: Calls play loud and clear. Fields all bunts close to home plate.', reps: '5 walk-throughs, 5 live' },
          ]},
          { label: '#2 Wheel Pick-Off (1st & 2nd)', activities: [
            { name: 'Wheel Pick-Off Play', description: 'Runners on first-and-second, 0-out. Obvious bunt. Pick-off play to keep base runners honest. Primary objective: keep runner close at 2B for the force at 3B.', instructions: '3B: Receives sign, slight body angle facing pitcher. Takes 1-2 hard charge steps toward home, stops, retreats to 3B for possible rundown. SS: As pitcher begins his motion, begins to creep in on base runner\'s right shoulder. Makes sure pitcher is set. After seeing pitcher turn to throw to 2B, breaks hard to 3B, stops and circles to the outside back to 2B for possible rundown. 2B: Creeps in. As pitcher turns away from breaking SS, keys the back of pitcher\'s head and breaks to cover 2B. 1B: One or two steps in on grass as decoy. P: Keys the SHORTSTOP (does not vary head looks). Once SS breaks toward 3B, pitcher locks on home plate, turns and delivers firm chest-high throw to 2B. Breaks toward 3B for possible rundown.', reps: '5 walk-throughs, 3 live' },
          ]},
          { label: '#3 Wheel (1st & 2nd)', activities: [
            { name: 'Wheel Play', description: 'Runners on first-and-second, 0-out. Get the lead out at 3B. Secondary: get the out at 1B.', instructions: '3B: Receives sign, slight body angle facing pitcher, squares up to home plate with pitch. Can play 1-2 steps behind bag on soft bunts. Takes charge on hard bunts, calls off pitcher. SS: At DP depth, keeps runner close, "daylight" pick-off play possible, covers 2B. 2B: At DP depth, reads bunt, breaks in, covers 1B. 1B: On edge of grass, reads bunt and charges to cover area between foul line and mound. Takes bunts up the middle. P: Holds runner at 2B (possible daylight play with SS). Delivers strike, reads bunt, breaks off mound to 3B side. Yields to 3B if called. C: Calls play loud and clear. Fields all bunts close to home plate.', reps: '5 walk-throughs, 5 live' },
          ]},
          { label: 'Squeeze Play & First-and-Third', activities: [
            { name: 'Squeeze Play Defense', description: 'Runner on third. Get the runner at home plate. Secondary: get out at first base.', instructions: '3B: As runner breaks for home, 3B breaks with him. SS: Cover 3B. 2B: Cover 1B/Read first baseman or cover 2B. 1B: As hitter squares to bunt, breaks to home plate or covers 1B. P: Breaks straight to home plate. C: Protects home plate.', reps: '5 walk-throughs' },
            { name: 'First-and-Third Defense - Option I', description: 'Focus on the out at second. We are NOT concerned with runner at third.', instructions: 'As runner breaks to 2B, catcher comes up throwing to 2B. He does not peek at runner on 3B. We disregard the runner breaking from 3B to home and take the out at 2B.', reps: '3 reps' },
            { name: 'First-and-Third Defense - Option II', description: 'Focus on the out at home plate. Entice runner at third to break.', instructions: 'As runner breaks to 2B, catcher comes up throwing. Peek at runner on 3B. Infielder receiving gets in position to make tag at 2B. As runner breaks home, infielder returns throw to catcher. Footwork: left to ball, right to left, left to home.', reps: '3 reps' },
            { name: 'First-and-Third Defense - Options III & IV', description: 'Direct throw to third base or hold ball/pump fake.', instructions: 'III: Catcher throws directly to 3B (pump fake at manager\'s discretion). Middle infielders hold position. As ball gets by hitter, 3B flows toward 3B. IV: Hold ball or pump fake at manager\'s discretion.', reps: '3 reps each' },
          ]},
          { label: 'Pick-Offs & Daylight Plays', activities: [
            { name: 'Catcher\'s Pick-Off Signs', description: 'Learn catcher\'s pick-off signs and proper execution.', instructions: 'Thumb: throw over (thumb points to 3B for pick at 1B). Flap Extension: hard step off and check runner. Hand slide down thigh plus sign: quick step. Same number three times (3x"1", 3x"2"): pitch out. Horn sign with runners on 1st and 3rd: pitcher fakes to 3B, throws to 1B.', reps: 'Review and 5 live reps' },
            { name: '"No Look" Pick-Off', description: 'Aggressive base runner at second. Catcher relays sign to pitcher and infielders.', instructions: 'Catcher receives sign from manager, relays with glove up for target. When middle infielder breaks he drops his glove. Pitcher receives sign, comes "locked" on home plate. As catcher drops glove, turns and delivers firm chest-high throw to 2B.', reps: '5 reps' },
            { name: '"Daylight" Situation', description: 'Aggressive base runner at second. No sign needed - simply a "read" by either middle infielder.', instructions: 'SS extends glove and breaks hard to 2B. Pitcher turns and makes firm chest-high throw. 2B extends "open" hand and breaks hard. Pitchers should break toward 3B for possible rundown after the throw.', reps: '5 reps' },
          ]},
          { label: 'Relay & Cut-Off Fundamentals', activities: [
            { name: 'General Relay Rules', description: 'Balls down the line or in gaps = double, possible triple. Line up to 3B if 1B unoccupied, to home if 1B occupied.', instructions: 'Cut-off men position at back of mound (dirt/grass line) in direct line with outfielder, relay man, and proper base. Stay "square" until ball is in flight, then get around the ball, replace feet for momentum. Primary relay man never leave his feet to catch a throw or attempt to pick a short hop.', reps: '5 walk-throughs' },
            { name: 'Relay Calls', description: 'Learn the call system for cut-off plays.', instructions: 'Number of base = cut and throw to that base (e.g. "4,4,4" = cut, throw to home). "CUT" = cut throw and check for other possible plays. NO SOUND = let throw go through. On relays, the double cut man makes the call.', reps: 'Review and practice' },
            { name: 'Tags', description: 'Straddle the base and let the ball come to you. Tag hard, straight down!', instructions: 'Position yourself straddling the base. Wait for the throw. When you catch it, bring the glove straight down to apply a hard tag.', reps: '10 tag plays' },
          ]},
          { label: 'Cut-Off Patterns - No One On', activities: [
            { name: 'Single to Left Field (No One On)', description: 'Every position\'s movement on a single to left field with bases empty.', instructions: 'P: Backup position between 1B and 2B. C: Follow hitter to 1B, ready to cover if 1B leaves bag. 1B: Break to area inside base, make sure hitter touches first, then cover. Be ready for overthrow by LF. 2B: Cover 2B. SS: Move into relay position to 2B (assume runner advances). 3B: Protect 3B area. LF: Field ball and throw to 2B, no short hops. CF: Back up LF. RF: Possible backup behind 2B.', reps: '3 walk-throughs' },
            { name: 'Single to Center Field (No One On)', description: 'Every position\'s movement on a single to center field with bases empty.', instructions: 'P: Backup between mound and 2B. C: Follow hitter to 1B, back up 1B. Anticipate 2B or SS throwing behind runner. 1B: Break inside base, hitter touches first, then cover. 2B: Go for ball, communicate with SS on who is relay man and who covers 2B. SS: Same as 2B - communicate. 3B: Protect 3B area. LF: Back up CF. CF: Field ball, throw to 2B, no short hops. RF: Back up CF.', reps: '3 walk-throughs' },
            { name: 'Single to Right Field (No One On)', description: 'Every position\'s movement on a single to right field with bases empty.', instructions: 'P: Backup between 2B and 3B. C: Follow hitter to 1B, give room to back up 1B if RF throws behind runner. 1B: Break inside base, hitter touches first, then cover. 2B: Move into relay position to 2B (assume runner advances). SS: Cover 2B. 3B: Protect 3B area. LF: Possible backup toward 3B. CF: Back up RF. RF: Field ball, throw to 2B, no short hops.', reps: '3 walk-throughs' },
          ]},
          { label: 'Cut-Off Patterns - Runner on 1B', activities: [
            { name: 'Single to Left Field (Runner on 1B)', description: 'Every position\'s movement on a single to LF with runner on first.', instructions: 'P: Back up 3B. C: Protect home plate. 1B: Make sure hitter touches 1B, then cover. 2B: Cover 2B. SS: Move into position to be the relay man. Assume runner will attempt to advance. 3B: Cover 3B. LF: Field ball and make a throw that can be cut-off by the SS. CF: Back up LF. RF: Possible backup near 2B.', reps: '3 walk-throughs' },
            { name: 'Single to Center Field (Runner on 1B)', description: 'Every position\'s movement on a single to CF with runner on first.', instructions: 'P: Back up 3B. C: Protect home plate. 2B: Cover 2B. SS: Move into position to be the relay man. Assume runner will attempt to advance. 3B: Cover 3B. LF: Back up CF. CF: Field ball and make a throw that can be cut-off by the SS. RF: Back up CF.', reps: '3 walk-throughs' },
            { name: 'Single to Right Field (Runner on 1B)', description: 'Every position\'s movement on a single to RF with runner on first.', instructions: 'P: Back up 3B. C: Protect home plate. 1B: Make sure hitter touches 1B, then cover. 2B: Cover 2B. SS: Move into position to be the relay man. Assume runner will attempt to advance. 3B: Cover 3B. LF: Possible backup behind 3B. CF: Back up RF. RF: Field ball and make a throw that can be cut-off by the SS.', reps: '3 walk-throughs' },
          ]},
          { label: 'Cut-Off Patterns - Runner on 2B+', activities: [
            { name: 'Single to LF (Runner on 2B, 1B & 2B, or Bases Loaded)', description: 'Every position\'s movement when runner is scoring from second or further.', instructions: 'P: Back up home plate. C: Cover home plate. 1B: Cover 1B. 2B: Cover 2B. SS: Cover 3B. 3B: Move into position to be the cut-off man to home plate. LF: Field ball and throw to home plate through the cut-off. CF: Back up LF. RF: Possible backup near 2B.', reps: '3 walk-throughs' },
          ]},
          { label: 'Defensive Positioning', activities: [
            { name: '2B Positioning', description: 'Line from 3B corner of plate through edge of dirt on mound. Find Straight Right, Straight Left, Double Play, and Split Defense marks.', instructions: 'Straight Right (SR): 1 step plus one shoe size from line to left toward 1B. Straight Left (SL): 3 steps to the left from SR and square up. Double Play (DP): 5 steps in on an angle to plate from SR. Split Defense: Halfway between marks.', reps: 'Walk through each position' },
            { name: 'SS Positioning', description: 'Line from 1B corner of plate through edge of dirt on mound.', instructions: 'Straight Left (SL): 1 step plus one shoe size from line to the right toward 3B. Straight Right (SR): 3 steps to the right from SL mark and square up. Double Play (DP): 5 steps in on angle to plate from SL. Split Defense: Halfway between marks.', reps: 'Walk through each position' },
            { name: '1B Positioning', description: 'Straight Left (SL): 8 steps up the line and 6 steps to the left.', instructions: 'Straight Right (SR): 2 steps over and 2 steps in from SL.', reps: 'Walk through each position' },
            { name: '3B Positioning', description: 'Straight Right (SR): 8 steps up the line and 6 steps out (plus arm can use 10 steps up and 6 over).', instructions: 'Straight Left (SL): 2 steps over from SR (for typical power LHH, need to play in on cut of the grass for hitters who slap/bunt). Double Play: 2 steps in from SR.', reps: 'Walk through each position' },
          ]},
        ],
      },
      {
        title: 'Perry Hill: Drills & Practice',
        description: 'All individual and team drills from the Perry Hill infield system: ready position, short hops, on-knees, wide base, toss & feeds, wall drills, closed eye drill, tags, relays, and more.',
        positions: '1B,2B,SS,3B',
        days: [
          { label: 'Individual Drills', activities: [
            { name: 'Ready Position Drill', description: 'Walking into the pitch: on the balls of feet, off the heels, with glove open in front of body.', instructions: 'Work during BP off coaches and simulate off the fungo. Practice the Feet (F1) on every single pitch.', reps: '10 reps' },
            { name: 'Short Hops Drill', description: 'Reinforce good fielding position - wide base, knees and back bent, hands out front.', instructions: 'Practice routine short hops, backhand short hops, and extended backhand short hops.', reps: '10 each type' },
            { name: 'On-Knees Hand Drill', description: 'Infielder on his knees, coach 20-25 feet away, hitting firm fungo to player\'s right and left.', instructions: 'This is a reaction drill to improve hand quickness. Focus on tracking the ball into the glove.', reps: '20 reps' },
            { name: 'Wide Base Drill', description: 'Hard ground balls directly at player. Demonstrates how a wide base enables the infielder to get hands in front where eyes track the ball.', instructions: 'A narrow base pulls hands in, creating a blind spot. Wide base keeps glove out front and visible.', reps: '10 ground balls' },
            { name: '5-Error Drill', description: 'Five types of hops in sequence to practice reactions.', instructions: '1) 1 or 2 steps in front. 2) To the right. 3) To the left. 4) Underneath and behind. 5) 5 or 6 steps in front.', reps: '5 sequences' },
          ]},
          { label: 'Feeds, Toss & Throwing Drills', activities: [
            { name: 'Toss and Feeds', description: 'Reinforce the importance of using the legs to keep infielder from "slinging" or "wristing" the ball.', instructions: 'Use proper leg drive on all tosses and feeds. Keep throws firm and controlled.', reps: '10 each type' },
            { name: 'Soft Toss Ground Balls', description: 'React to the ball off the bat creating game situations.', instructions: 'Emphasis on angles, approach, and footwork. Create different game scenarios.', reps: '15 ground balls' },
            { name: 'Off-Balance Throwing', description: 'Reinforce footwork and throwing mechanics from awkward positions.', instructions: 'Ball in glove, making exchange "in the middle" and throwing off the right foot. Field left, throw right. Hand behind ball, not under.', reps: '10 throws' },
            { name: 'Action-Reaction Decision-Making', description: 'Take simulated throws off fungo from different areas of the infield (primarily for first basemen).', instructions: 'Concentrate on footwork and decision-making (when to come off the bag to save an errant throw). Can also be used for tags at all infield positions.', reps: '10 plays' },
          ]},
          { label: 'Team Drills', activities: [
            { name: 'Closed Eye Drill', description: 'Reinforce proper fundamentals and throwing mechanics with eyes closed.', instructions: 'Routine ground balls, routine backhand, extended backhand, slow rollers and bunts, double plays. Close eyes, field, open eyes, throw.', reps: '5 each type' },
            { name: 'Pop-Ups', description: 'Let the ball reach its peak, stay "behind" the ball, then make the call three times.', instructions: 'Ball in outfield: no call unless player is "camped" underneath the ball. If infielder turns wrong way, continue in same direction and look over opposite shoulder. Infielder always yields to outfielder if he makes the call.', reps: '10 pop-ups' },
            { name: 'Tags Drill', description: 'Simulate game situations. Straddle the base and let the ball come to you.', instructions: 'Tag hard, straight down! Practice at all bases.', reps: '10 tags' },
            { name: 'Relays Drill', description: 'During long toss, simulate relay plays: hands up, get around the ball while receiving close in.', instructions: 'Replace feet to create direction and momentum. Practice right-to-left, left-to-target footwork.', reps: '10 relay throws' },
            { name: 'Rundowns Drill', description: 'Simulate rundown plays. Ball up, run hard, receiving player breaks hard and yells "NOW."', instructions: 'Receiving player gets the ball on the run and makes the tag. Goal is one throw only. On ground ball to 3B with runner on 3B, run the base runner toward home plate for a one-throw play.', reps: '5 rundowns' },
            { name: 'Wall Drills', description: 'Player throws ball off a wall and fields. Emphasis on fielding position and proper footwork.', instructions: 'Set up in proper angle for throws. A partner can stand behind the fielder and make the throw off the wall. This drill simulates all infield plays.', reps: '15 reps' },
          ]},
          { label: 'Pre-Game Infield/Outfield', activities: [
            { name: 'Round 1 - Getting One (At Him/Left)', description: 'Ground ball to each infielder at him or to his left. Throw to 1B. Ball goes around the horn.', instructions: 'Ground ball to 3B (throw to 1B, catcher returns, pivot at 2B). Then SS, 2B same pattern. 1B at normal depth (at him or right) - shortstop looks to complete 3-6-3. If unable, SS pump-fakes and throws to 3B. Roll ball to catcher for one, first baseman throws to 2B, ball comes home.', reps: '1 full round' },
            { name: 'Round 2 - Getting One (To His Right)', description: 'Same as round 1, except ball is hit to the right of each infielder. Second baseman gets ball down the line for first baseman.', instructions: 'Ball hit to right of 3B, SS, 2B, and down the line for 1B. Same throw patterns and horn sequence.', reps: '1 full round' },
            { name: 'Round 3 - Double Plays (At Him/Left)', description: 'Ground ball to each infielder at him or to his left. Execute double play turn.', instructions: '3B: Catcher throws to 3B, 3B goes across diamond to 1B. SS: Catcher throws to 2B, 2B turns throws to off catcher. 2B (at him or right): Catcher throws to 2B, SS turns. 1B: Working off the base, if SS can complete 3-6-3, 1B returns ball to off catcher. Otherwise SS pump-fakes to 1B, throws to 3B. Roll ball to catcher for two.', reps: '1 full round' },
            { name: 'Round 4 - Double Plays (To His Right)', description: 'Same as round 3 but ball hit to the right. First baseman starts behind runner.', instructions: 'All throws return to the plate for double play practice.', reps: '1 full round' },
            { name: 'Round 5 - Long Round', description: 'Ground ball deep on the line. Shortstop is deep in the hole. Second baseman is behind the bag. First baseman starts "in" and throws home.', instructions: 'After the long round, hit a slow roller to each infielder. First baseman throws to 3B (simulate a bad bunt).', reps: '1 full round' },
            { name: 'Round 6 - Pop Ups to Catcher', description: 'Infielders stay in position for possible pop up. Run off field after the last pop up.', instructions: 'Pop ups to catcher. Catchers are to wear catching gear throughout the infield/outfield process.', reps: 'Until complete' },
          ]},
        ],
      },
      {
        title: 'Perry Hill: Mental Preparation',
        description: 'Confidence, Concentration, Consistency, communication, defensive positioning awareness, and pre-game mental preparation from the Perry Hill infield system.',
        positions: '1B,2B,SS,3B',
        days: [
          { label: 'Confidence & Concentration', activities: [
            { name: 'Confidence Mindset', description: 'Every infielder should have positive thoughts and BELIEVE he is the best at his position.', instructions: 'Your thoughts MUST BE: "I am mentally ready to play. I know I have the talent. I can handle any ground ball, pop fly, etc. I expect the ball to be coming at me every pitch. I WANT it coming my way because I KNOW I can make the play."', reps: 'Before every game' },
            { name: 'Concentration for Every Pitch', description: 'On every pitch you should be ready to make any play. Total concentration for 2-3 hours is not too much to ask.', instructions: 'When pitching is good, defense is usually good and vice versa. MUST maintain high intensity and concentration REGARDLESS of how the game is going. When the pitcher is struggling, it is vital that you make the good play to end the inning. Do not let hitting affect your fielding.', reps: 'Every inning' },
            { name: 'Consistency', description: 'Strive to make the routine play every time. THE ROUTINE PLAY IS A MUST!', instructions: 'Most young infielders make 5-20 "careless" errors per season. If you make great, spectacular plays, that\'s a bonus. The routine play every time, day in and day out is the goal.', reps: 'Every game' },
          ]},
          { label: 'Communication & Game Awareness', activities: [
            { name: 'Communication on the Field', description: 'Be enthusiastic and communicate with each other during the game. Remind everyone of all possible situations.', instructions: 'Keep each other in the ball game. The game is not that tough to play. Have some fun together between the white lines. You don\'t need to be a cheerleader, but stay engaged.', reps: 'Every inning' },
            { name: 'Know Your Pitching Staff', description: 'Basic positioning varies depending on the type of pitcher on the mound.', instructions: 'Knowing your pitcher allows you to shade or cheat a little either way. Keep tabs on your pitcher during the game by checking with the catcher. A pitcher\'s stuff varies from game to game.', reps: 'Pre-game review' },
            { name: 'Know Opposing Hitters', description: 'Make adjustments according to the type of hitter at the plate.', instructions: 'Know the hitter\'s running speed, bat control, bunting ability, bat speed, and bat arc. Be aware of the count - most hitters won\'t pull as much when behind 1-2 or 0-2. Make the necessary adjustments.', reps: 'Pre-game review' },
            { name: 'Know Opposing Club Tendencies', description: 'What do opposing clubs like to do in certain situations? Bunt, hit and run, steal, delayed steal, squeeze.', instructions: 'DO NOT BE CAUGHT BY SURPRISE! Make mental notes when situations occur and you will be able to anticipate what some clubs are going to do. YOU WILL BE READY!', reps: 'Pre-game review' },
            { name: 'Check Field Conditions & Wind', description: 'Notice how ground balls play during batting practice. Check wind conditions each inning.', instructions: 'Your positioning may vary due to fast or slow infields. An unnoticed wind change has made many infielders look foolish on high pop-ups. Check every inning!', reps: 'Pre-game and every inning' },
            { name: 'Check the Foul Lines', description: 'Before each game, 1B and 3B should roll baseballs down each base path.', instructions: 'See if the ball will stay fair or roll foul on slow hit or bunted balls. This knowledge gives you an edge.', reps: 'Pre-game' },
            { name: 'Quality BP Work', description: 'Take all types of ground balls during batting practice the way you would during the game.', instructions: 'Balls to your left, right, routine balls, slow hit balls, double play feeds and pivots. Do not get lazy or just go through the motions - this only develops bad habits.', reps: 'During batting practice' },
          ]},
        ],
      },
    ];

    const results = [];
    for (const prog of programs) {
      const result = await db.addProgram({ title: prog.title, description: prog.description, program_type: 'training', schedule_type: 'sequential', team_id: req.teamId });
      await db.updateProgramPositions(result.id, prog.positions);
      for (let i = 0; i < prog.days.length; i++) {
        const d = prog.days[i];
        const day = await db.addProgramDay({ program_id: result.id, day_label: d.label, day_number: i, sort_order: i });
        for (let j = 0; j < d.activities.length; j++) {
          const a = d.activities[j];
          await db.addProgramActivity({ program_day_id: day.id, activity_name: a.name, description: a.description || null, instructions: a.instructions || null, reps: a.reps || null, link_url: null, image_url: null, sort_order: j });
        }
      }
      results.push(prog.title);
    }
    res.redirect('/admin/programs?success=' + encodeURIComponent(results.length + ' Perry Hill programs created: ' + results.join(', ')));
  } catch (err) {
    console.error('Perry Hill seed error:', err);
    res.redirect('/admin/programs?error=' + encodeURIComponent(err.message));
  }
});

app.post('/event/:id/save-as-program', requireAdmin, async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event) return res.redirect('/admin');
  const drills = await db.getDrills(event.id);
  if (drills.length === 0) return res.redirect('/event/' + event.id);
  const title = (req.body.template_name || '').trim() || event.title + ' Template';
  const result = await db.addProgram({ title, description: 'Saved from: ' + event.title, program_type: 'practice_template', schedule_type: 'sequential', team_id: req.teamId });
  const day = await db.addProgramDay({ program_id: result.id, day_label: 'Practice', day_number: 0, sort_order: 0 });
  for (const drill of drills) {
    await db.addProgramActivity({ program_day_id: day.id, activity_name: drill.drill_name, description: drill.description, instructions: drill.coach_notes, reps: drill.duration_minutes + ' min', sort_order: drill.sort_order });
  }
  res.redirect('/admin/programs/' + result.id + '/edit?success=Practice+plan+saved+as+template');
});

app.post('/event/:id/load-program', requireAdmin, async (req, res) => {
  const event = await db.getTeamEvent(Number(req.params.id));
  if (!event || event.event_type !== 'practice') return res.redirect('/admin');
  const programId = Number(req.body.program_id);
  const program = await db.getProgram(programId);
  if (!program) return res.redirect('/event/' + event.id);
  const days = await db.getProgramDays(program.id);
  const existingDrills = await db.getDrills(event.id);
  let order = existingDrills.length;
  for (const day of days) {
    const activities = await db.getProgramActivities(day.id);
    for (const act of activities) {
      await db.addDrill({
        team_event_id: event.id,
        drill_name: act.activity_name,
        description: act.description,
        duration_minutes: parseInt(act.reps) || 10,
        sort_order: order++,
        coach_notes: act.instructions,
      });
    }
  }
  res.redirect('/event/' + event.id);
});

// --- Position Quizzes ---

app.post('/admin/seed-quizzes', requireAdmin, async (req, res) => {
  const quizData = [
    {
      title: '1B Position Quiz',
      position: '1B',
      description: 'Test your knowledge of first base fundamentals from the Perry Hill Infield System.',
      questions: [
        { q: 'What is the proper starting position for a first baseman before the pitch?', a: 'Behind the bag, even with it', b: 'On the bag in a stretch position', c: 'Several steps behind the bag toward second', d: 'In foul territory near the line', correct: 'a' },
        { q: 'On a ground ball to another infielder, when should the first baseman go to the bag?', a: 'Immediately when the ball is hit', b: 'After the ball is fielded', c: 'When the throw is in the air', d: 'Only on routine grounders', correct: 'a' },
        { q: 'What footwork does Perry Hill teach for receiving throws at first base?', a: 'Always use the right foot on the bag', b: 'Always use the left foot on the bag', c: 'Use whichever foot the throw dictates', d: 'Both feet on the bag', correct: 'c' },
        { q: 'On a ball in the dirt, what should the first baseman prioritize?', a: 'Keeping the foot on the bag at all costs', b: 'Blocking the ball and keeping it in front', c: 'Swiping at the ball with the glove', d: 'Coming off the bag to catch it cleanly', correct: 'b' },
        { q: 'When holding a runner on first, where should your right foot be?', a: 'On top of the bag', b: 'Against the outfield side of the bag', c: 'Against the home plate side of the bag', d: 'Behind the bag in foul territory', correct: 'b' },
        { q: 'On a bunt toward the first base side, when does the first baseman charge?', a: 'On every bunt', b: 'Only when the pitcher cannot get it', c: 'When the ball is bunted hard toward them', d: 'The first baseman never charges bunts', correct: 'a' },
        { q: 'What is the 3-1 play?', a: 'First baseman throws to first, pitcher covers', b: 'First baseman fields bunt, throws to first with pitcher covering', c: 'Third baseman throws to first baseman', d: 'A pickoff play with the catcher', correct: 'b' },
        { q: 'On a pop fly near the dugout, what should the first baseman do with their glove hand?', a: 'Use it to feel for the railing/fence', b: 'Keep it on the glove', c: 'Wave off other fielders', d: 'Put it behind their back', correct: 'a' },
        { q: 'With a runner on first and a ground ball to you, when do you flip to the pitcher covering first?', a: 'Always underhand', b: 'Always overhand', c: 'Underhand from close range, overhand from distance', d: 'Never flip, always take it yourself', correct: 'c' },
        { q: 'What is the proper stretch position when receiving a throw at first?', a: 'Stretch as far as possible every time', b: 'Only stretch what is needed for that throw', c: 'Never stretch, just stand on the bag', d: 'Stretch and jump toward the throw', correct: 'b' },
      ]
    },
    {
      title: '2B Position Quiz',
      position: '2B',
      description: 'Test your knowledge of second base fundamentals from the Perry Hill Infield System.',
      questions: [
        { q: 'What does Perry Hill call the second baseman\'s starting depth?', a: 'Deep behind the baseline', b: 'Even with the bag', c: 'Double-play depth unless situation dictates otherwise', d: 'Always shallow on the grass', correct: 'c' },
        { q: 'On a double play ball hit to shortstop, what is the second baseman\'s footwork at the bag?', a: 'Come across the bag from the outfield side', b: 'Straddle the bag and throw', c: 'Touch the back corner and get out of the way', d: 'It depends on where the feed comes from', correct: 'd' },
        { q: 'What is the "inside move" at second base on a double play?', a: 'Cheating toward the bag before the pitch', b: 'Receiving the ball on the inside (home plate side) of the bag', c: 'Moving to the infield grass before a bunt', d: 'A pickoff move from the pitcher', correct: 'b' },
        { q: 'On a ground ball up the middle, what is the second baseman\'s priority?', a: 'Get in front of it and block', b: 'Backhand it and flip to short', c: 'Catch it cleanly, set feet, make a strong throw', d: 'Dive for everything', correct: 'c' },
        { q: 'When turning a double play, what should the second baseman do with their eyes?', a: 'Watch the runner coming from first', b: 'Look at the bag', c: 'Watch the ball into the glove, then find first base', d: 'Close their eyes and throw', correct: 'c' },
        { q: 'On a steal attempt at second, who covers the bag with a right-handed hitter?', a: 'Always the shortstop', b: 'Always the second baseman', c: 'Depends on the pre-pitch sign', d: 'Whoever is closer', correct: 'c' },
        { q: 'What is the relay position for the second baseman on a ball hit to right field?', a: 'Line up between the right fielder and home plate', b: 'Line up between right fielder and third base', c: 'Go to the cutoff spot between right fielder and the base the throw is going to', d: 'Always back up first base', correct: 'c' },
        { q: 'On a pop fly to shallow right field, who has priority?', a: 'The right fielder', b: 'The second baseman', c: 'The first baseman', d: 'Whoever calls it first', correct: 'a' },
        { q: 'When fielding a slow roller, what should the second baseman do?', a: 'Charge hard, bare-hand, throw on the run', b: 'Wait for it to come to them', c: 'Charge hard and field it with two hands when possible', d: 'Let the first baseman get it', correct: 'c' },
        { q: 'What is the proper tag technique on a steal at second base?', a: 'Catch and sweep tag in one motion', b: 'Catch the ball first, then apply the tag', c: 'Block the base with your body', d: 'Stand behind the bag and reach forward', correct: 'a' },
      ]
    },
    {
      title: 'SS Position Quiz',
      position: 'SS',
      description: 'Test your knowledge of shortstop fundamentals from the Perry Hill Infield System.',
      questions: [
        { q: 'What is the shortstop\'s pre-pitch ready position?', a: 'Standing straight up', b: 'Athletic stance with weight on balls of feet, slight movement', c: 'Deep crouch with hands on knees', d: 'Leaning toward second base', correct: 'b' },
        { q: 'On a double play ball hit to the second baseman, what does the shortstop do at the bag?', a: 'Always go behind the bag', b: 'Always straddle the bag', c: 'Adjust footwork based on the feed location', d: 'Just touch the bag and get off', correct: 'c' },
        { q: 'What is the "Six Fs" concept Perry Hill teaches?', a: 'Six fundamental fielding drills', b: 'Feet, Field, Funnel, Footwork, Fire, Follow', c: 'A conditioning routine', d: 'Six types of double plays', correct: 'b' },
        { q: 'On a backhand play in the hole, what should the shortstop focus on?', a: 'Getting in front of the ball every time', b: 'Planting the right foot and making a strong throw', c: 'Flipping to the second baseman', d: 'Diving and throwing from the ground', correct: 'b' },
        { q: 'On a ball hit up the middle, what is the shortstop\'s first responsibility?', a: 'Cover second base', b: 'Back up the second baseman', c: 'Field the ball if possible', d: 'Call for the center fielder', correct: 'c' },
        { q: 'Where should the shortstop position themselves for a cutoff on a ball to left-center?', a: 'Near second base', b: 'In a direct line between the outfielder and the target base', c: 'On the mound', d: 'In shallow left field', correct: 'b' },
        { q: 'When turning a double play from a ball hit directly to the shortstop, what is preferred?', a: 'Always go to second first', b: 'Tag the runner and throw to first', c: 'Feed to second baseman unless the ball is hit close to the bag', d: 'Throw to first for one out', correct: 'c' },
        { q: 'On a pop fly to shallow left field, who has priority?', a: 'The left fielder always', b: 'The shortstop', c: 'The third baseman', d: 'The outfielder coming in has priority over the infielder going out', correct: 'd' },
        { q: 'What is the shortstop\'s role with a runner on second and a bunt?', a: 'Cover third base', b: 'Cover second base', c: 'Charge the bunt', d: 'Back up the pitcher', correct: 'b' },
        { q: 'On a routine ground ball, where should the shortstop\'s throw go?', a: 'Chest height to the first baseman', b: 'At the first baseman\'s face', c: 'To the glove side of the first baseman, around chest height', d: 'Low to the ground so they can scoop it', correct: 'c' },
      ]
    },
    {
      title: '3B Position Quiz',
      position: '3B',
      description: 'Test your knowledge of third base fundamentals from the Perry Hill Infield System.',
      questions: [
        { q: 'What is the third baseman\'s standard depth?', a: 'On the grass, close to the bag', b: 'Deep behind the bag, near the outfield grass', c: 'Even with the bag, depending on the situation', d: 'Always at double-play depth', correct: 'c' },
        { q: 'On a bunt with a runner on first, what is the third baseman\'s primary job?', a: 'Stay at the bag', b: 'Charge the bunt aggressively', c: 'Read the bunt and either charge or hold depending on speed', d: 'Cover shortstop position', correct: 'b' },
        { q: 'What is the proper technique for a backhand play at third?', a: 'Dive for everything', b: 'Step with the left foot, backhand, plant right foot, throw', c: 'Spin and throw off balance', d: 'Use two hands every time', correct: 'b' },
        { q: 'On a slow roller to third, what is the footwork?', a: 'Charge, field outside the left foot, crow hop, throw', b: 'Wait for it, throw from a stand-still', c: 'Charge, bare hand, throw on the run', d: 'Let the shortstop get it', correct: 'c' },
        { q: 'When holding a runner on third, where should the third baseman be?', a: 'On the bag in foul territory', b: 'Behind the runner straddling the line', c: 'In front of the bag in fair territory', d: 'Several feet off the bag toward shortstop', correct: 'c' },
        { q: 'On a ground ball to the shortstop with runners on first and second, what does the third baseman do?', a: 'Cover third base for the force', b: 'Back up shortstop', c: 'Go to the mound', d: 'Cut off the throw', correct: 'a' },
        { q: 'What makes a good tag play at third base?', a: 'Catch the ball, bring glove down in front of the bag', b: 'Block the bag with your body', c: 'Swipe tag across the runner', d: 'Stand behind the bag', correct: 'a' },
        { q: 'On a line drive hit right at the third baseman, what is the priority?', a: 'Knock it down', b: 'Catch it with soft hands, check the runner', c: 'Dive out of the way', d: 'Barehand it', correct: 'b' },
        { q: 'On a double play ball to third with a runner on first, where does the throw go?', a: 'Always to first base', b: 'Always to second base', c: 'Step on third if close enough, otherwise throw to second for the DP', d: 'Hold the ball', correct: 'c' },
        { q: 'What is the third baseman\'s communication responsibility on pop flies?', a: 'Never call for any ball', b: 'Call off the catcher and pitcher on pop flies in the area', c: 'Only catch balls in foul territory', d: 'Defer to the shortstop on everything', correct: 'b' },
      ]
    },
    {
      title: 'General Infield Quiz',
      position: 'IF',
      description: 'Test your general infield knowledge from the Perry Hill Infield System.',
      questions: [
        { q: 'What does "Funnel" mean in the Six Fs?', a: 'Throwing with a funnel grip', b: 'Bringing the ball from glove to center of body to throwing position', c: 'Fielding with a wide stance', d: 'Running in a curved path to the ball', correct: 'b' },
        { q: 'According to Perry Hill, what is the most important quality of a good infielder?', a: 'Speed', b: 'Arm strength', c: 'Soft hands and good footwork', d: 'Size', correct: 'c' },
        { q: 'What does "read hop" mean?', a: 'Reading the pitcher\'s delivery', b: 'Judging whether to field a short hop or long hop', c: 'Hopping over the ball', d: 'Counting hops before the ball arrives', correct: 'b' },
        { q: 'When fielding a ground ball, where should your eyes be?', a: 'On the runner', b: 'On the target', c: 'On the ball into the glove', d: 'On the coach', correct: 'c' },
        { q: 'What is the purpose of a "crow hop" after fielding?', a: 'To show off', b: 'To generate momentum and get the feet aligned for a strong throw', c: 'To avoid the runner', d: 'To delay the throw', correct: 'b' },
        { q: 'On a ground ball with no one on base, what is the priority?', a: 'Throw as hard as possible', b: 'Get the out at first with a clean, accurate throw', c: 'Hurry and throw off balance', d: 'Look the runner back', correct: 'b' },
        { q: 'What does Perry Hill teach about pre-pitch movement?', a: 'Stand completely still', b: 'Take a small creep step forward as the pitch is delivered', c: 'Jump right before the pitch', d: 'Move side to side', correct: 'b' },
        { q: 'On a rundown play, how many throws should it take?', a: 'As many as needed', b: 'No more than two', c: 'Exactly one', d: 'Three to four', correct: 'b' },
        { q: 'What is the correct arm slot for an infielder\'s throw?', a: 'Always overhand', b: 'Always sidearm', c: 'The natural arm slot that generates accuracy', d: 'Underhand only', correct: 'c' },
        { q: 'When should infielders communicate on fly balls?', a: 'Only the captain calls', b: 'Always — call "mine" or "you" early and loud', c: 'Never, just go get it', d: 'Only in the outfield', correct: 'b' },
      ]
    },
  ];

  for (const quiz of quizData) {
    const existing = await db.getQuizzesByPosition(quiz.position);
    if (existing.some(q => q.title === quiz.title)) continue;
    const created = await db.createQuiz({ title: quiz.title, position: quiz.position, description: quiz.description, team_id: req.teamId });
    for (let i = 0; i < quiz.questions.length; i++) {
      const q = quiz.questions[i];
      await db.addQuizQuestion({
        quiz_id: created.id,
        question_text: q.q,
        option_a: q.a,
        option_b: q.b,
        option_c: q.c || null,
        option_d: q.d || null,
        correct_answer: q.correct,
        sort_order: i
      });
    }
  }
  res.redirect('/admin/quizzes?success=' + encodeURIComponent('Position quizzes seeded successfully!'));
});

app.get('/admin/quizzes', requireAdmin, async (req, res) => {
  const quizzes = await db.getAllQuizzes(req.teamId);
  const players = await db.getAllPlayers(req.teamId);
  const quizStats = {};
  for (const q of quizzes) {
    const assignments = await db.getQuizAssignments(q.id);
    const attempts = await db.getAllQuizAttempts(q.id);
    quizStats[q.id] = { assigned: assignments.length, attempted: new Set(attempts.map(a => a.player_id)).size, attempts: attempts.length };
  }
  res.render('admin-quizzes', {
    quizzes, players, quizStats, POSITIONS,
    success: req.query.success || null, error: req.query.error || null
  });
});

app.post('/admin/quizzes/assign', requireAdmin, async (req, res) => {
  const quizId = Number(req.body.quiz_id);
  const quiz = await db.getQuiz(quizId);
  if (!quiz) return res.redirect('/admin/quizzes?error=Quiz not found');

  const players = await db.getAllPlayers(req.teamId);
  const targetPos = quiz.position === 'IF' ? ['1B','2B','3B','SS'] : [quiz.position];
  let assigned = 0;
  for (const p of players) {
    const posSource = p.coach_assigned_positions || p.best_positions || '';
    const playerPositions = posSource.split(',').map(s => s.trim()).filter(Boolean);
    if (quiz.position === 'IF' || targetPos.some(tp => playerPositions.includes(tp))) {
      await db.assignQuiz(quizId, p.id);
      assigned++;
    }
  }
  res.redirect('/admin/quizzes?success=' + encodeURIComponent(`Assigned "${quiz.title}" to ${assigned} players.`));
});

app.post('/admin/quizzes/assign-all', requireAdmin, async (req, res) => {
  const quizId = Number(req.body.quiz_id);
  const quiz = await db.getQuiz(quizId);
  if (!quiz) return res.redirect('/admin/quizzes?error=Quiz not found');
  const players = await db.getAllPlayers(req.teamId);
  for (const p of players) {
    await db.assignQuiz(quizId, p.id);
  }
  res.redirect('/admin/quizzes?success=' + encodeURIComponent(`Assigned "${quiz.title}" to all ${players.length} players.`));
});

app.get('/admin/quizzes/:id/results', requireAdmin, async (req, res) => {
  const quiz = await db.getQuiz(Number(req.params.id));
  if (!quiz) return res.redirect('/admin/quizzes');
  const questions = await db.getQuizQuestions(quiz.id);
  const attempts = await db.getAllQuizAttempts(quiz.id);
  const assignments = await db.getQuizAssignments(quiz.id);
  res.render('admin-quiz-results', { quiz, questions, attempts, assignments });
});

app.get('/quiz/attempt/:id', async (req, res) => {
  const attempt = await db.getQuizAttempt(Number(req.params.id));
  if (!attempt) return res.status(404).send('Attempt not found');
  const questions = await db.getQuizQuestions(attempt.quiz_id);
  let answers = {};
  try { answers = JSON.parse(attempt.answers_json || '{}'); } catch(e) {}
  const isAdmin = !!req.session.admin;
  res.render('quiz-result', { attempt, questions, answers, isAdmin });
});

app.get('/quiz/:quizId/take/:playerId', async (req, res) => {
  const quizId = Number(req.params.quizId);
  const playerId = Number(req.params.playerId);
  const quiz = await db.getQuiz(quizId);
  const player = await db.getPlayer(playerId);
  if (!quiz || !player) return res.status(404).send('Quiz or player not found');

  const attempts = await db.getQuizAttempts(quizId, playerId);
  let blocked = false;
  let blockedUntil = null;
  if (attempts.length >= 2) {
    const lastAttempt = new Date(attempts[0].completed_at);
    const unlockTime = new Date(lastAttempt.getTime() + 48 * 60 * 60 * 1000);
    if (new Date() < unlockTime) {
      blocked = true;
      blockedUntil = unlockTime;
    }
  }

  const questions = await db.getQuizQuestions(quizId);
  res.render('quiz-take', { quiz, player, questions, attempts, blocked, blockedUntil });
});

app.post('/quiz/:quizId/submit/:playerId', async (req, res) => {
  const quizId = Number(req.params.quizId);
  const playerId = Number(req.params.playerId);
  const quiz = await db.getQuiz(quizId);
  const player = await db.getPlayer(playerId);
  if (!quiz || !player) return res.status(404).send('Not found');

  const attempts = await db.getQuizAttempts(quizId, playerId);
  if (attempts.length >= 2) {
    const lastAttempt = new Date(attempts[0].completed_at);
    const unlockTime = new Date(lastAttempt.getTime() + 48 * 60 * 60 * 1000);
    if (new Date() < unlockTime) return res.status(403).send('You must wait 48 hours before your next attempt.');
  }

  const questions = await db.getQuizQuestions(quizId);
  const answers = {};
  let score = 0;
  for (const q of questions) {
    const answer = req.body['q_' + q.id] || '';
    answers[q.id] = answer;
    if (answer === q.correct_answer) score++;
  }

  const attempt = await db.addQuizAttempt({
    quiz_id: quizId,
    player_id: playerId,
    score,
    total: questions.length,
    answers_json: JSON.stringify(answers)
  });

  const pct = Math.round((score / questions.length) * 100);
  const resultUrl = `https://cal-ripken-allstars.onrender.com/quiz/attempt/${attempt.id}`;
  const smsBody = `Quiz Result: ${player.player_name} scored ${score}/${questions.length} (${pct}%) on "${quiz.title}"\n${resultUrl}`;

  try {
    const staff = await db.getAllStaff(req.teamId);
    const adminPlayers = await db.getPlayersByPhone('9413026510');
    const phones = new Set();
    phones.add('9413026510');
    for (const s of staff) {
      if (s.phone && s.phone.length === 10) phones.add(s.phone);
    }
    for (const phone of phones) {
      try { await sendSMS(phone, smsBody); } catch(e) { console.error('Quiz SMS error:', e.message); }
    }
  } catch(e) { console.error('Quiz notification error:', e.message); }

  res.redirect('/quiz/attempt/' + attempt.id);
});

app.get('/admin/notify-ready', requireAdmin, async (req, res) => {
  const msg = 'All features deployed and ready to test!\n\n' +
    '1. Team Board Reactions: https://cal-ripken-allstars.onrender.com/messages\n' +
    '2. Position Quizzes: https://cal-ripken-allstars.onrender.com/admin/quizzes\n\n' +
    'Seed the quizzes from the admin quiz page, then assign by position. Players can take quizzes from their profile page.';
  try {
    await sendSMS('9413026510', msg);
    res.send('Notification sent!');
  } catch(e) {
    res.send('Error: ' + e.message);
  }
});

// --- Staff View (read-only) ---
app.get('/staff', (req, res) => {
  res.render('staff-login', { error: null });
});

app.post('/staff', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  // Staff sign in by phone with no session team yet — look up across all
  // teams, then adopt whichever team that staff row belongs to.
  const staff = await db.getStaffByPhone(phone);
  if (!staff) {
    return res.render('staff-login', { error: 'Phone number not recognized as staff.' });
  }
  if (staff.team_id) req.session.currentTeamId = staff.team_id;
  res.redirect('/staff/dashboard?phone=' + phone);
});

app.get('/staff/dashboard', async (req, res) => {
  const phone = normalizePhone(req.query.phone || '');
  const staff = await db.getStaffByPhone(phone);
  if (!staff) return res.redirect('/staff');

  // Scope the dashboard to the staff member's own team, not the session's.
  const staffTeamId = staff.team_id || req.teamId;
  const players = await db.getAllPlayers(staffTeamId);
  const confirmed = players.filter(p => p.status === 'confirmed').length;
  const declined = players.filter(p => p.status === 'declined').length;
  const pending = players.filter(p => p.status === 'pending').length;
  const allEvents = await db.getAllEvents(staffTeamId);
  const teamEvents = await db.getAllTeamEvents(staffTeamId);
  res.render('staff-dashboard', { staff, players, confirmed, declined, pending, total: players.length, phone, RATING_FIELDS, allEvents, teamEvents, success: req.query.success || null, error: req.query.error || null });
});

app.get('/api/stats', async (req, res) => {
  const players = await db.getAllPlayers(req.teamId);
  const confirmed = players.filter(p => p.status === 'confirmed').length;
  const declined = players.filter(p => p.status === 'declined').length;
  const pending = players.filter(p => p.status === 'pending').length;
  res.json({ total: players.length, confirmed, declined, pending, players });
});

app.use((err, req, res, next) => {
  console.error('Express error:', err);
  if (res.headersSent) return next(err);
  if (req.headers['content-type'] === 'application/json' || req.xhr) {
    return res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
  res.status(500).send('Something went wrong. Please go back and try again.');
});

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Team portal running at http://localhost:${PORT}`);
  });
  setInterval(checkAndSendReminders, 15 * 60 * 1000);
  setTimeout(checkAndSendReminders, 15000);
  setInterval(checkAndSendProgramReminders, 15 * 60 * 1000);
  setTimeout(checkAndSendProgramReminders, 20000);
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
