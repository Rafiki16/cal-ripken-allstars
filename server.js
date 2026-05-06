const express = require('express');
const path = require('path');
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

app.get('/', async (req, res) => {
  const players = await db.getAllPlayers();
  const confirmed = players.filter(p => p.status === 'confirmed').length;
  const declined = players.filter(p => p.status === 'declined').length;
  const pending = players.filter(p => p.status === 'pending').length;
  res.render('index', { players, confirmed, declined, pending, total: players.length });
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
