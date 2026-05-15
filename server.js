const express    = require('express');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'anatomia_fisio_secret_2024';
const MONGO_URI  = process.env.MONGO_URI;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => { console.error('❌ Erro:', err); process.exit(1); });

const userSchema = new mongoose.Schema({
  username:  { type: String, unique: true, required: true },
  password:  { type: String, required: true },
  is_admin:  { type: Boolean, default: false },
  streak:    { type: Number, default: 0 },
  longest:   { type: Number, default: 0 },
  last_play: { type: String, default: null },
}, { timestamps: true });

const gameSchema = new mongoose.Schema({
  user_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username:   { type: String, required: true },
  score:      { type: Number, required: true },
  categories: { type: [String], default: [] },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Game = mongoose.model('Game', gameSchema);

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Token ausente' });
  const token = header.split(' ')[1];
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido' }); }
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

async function updateStreak(userId) {
  const user      = await User.findById(userId);
  const today     = todayStr();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let newStreak   = user.streak;
  if (user.last_play === today) {}
  else if (user.last_play === yesterday) newStreak = user.streak + 1;
  else newStreak = 1;
  const newLongest = Math.max(newStreak, user.longest);
  await User.findByIdAndUpdate(userId, { streak: newStreak, longest: newLongest, last_play: today });
  return { streak: newStreak, longest: newLongest };
}

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Usuário e senha obrigatórios' });
    if (username.length < 3) return res.status(400).json({ error: 'Mínimo 3 caracteres' });
    if (password.length < 4) return res.status(400).json({ error: 'Mínimo 4 caracteres' });
    if (await User.findOne({ username })) return res.status(409).json({ error: 'Usuário já existe' });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hash });
    const token = jwt.sign({ id: user._id, username, is_admin: false }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username, is_admin: false, streak: 0, longest: 0 });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Usuário e senha obrigatórios' });
    const user = await User.findOne({ username });
    if (!user || !await bcrypt.compare(password, user.password))
      return res.status(401).json({ error: 'Usuário ou senha incorretos' });
    const token = jwt.sign({ id: user._id, username: user.username, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, is_admin: user.is_admin, streak: user.streak, longest: user.longest });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/api/me/stats', authMiddleware, async (req, res) => {
  try {
    const user  = await User.findById(req.user.id);
    const games = await Game.find({ user_id: req.user.id }, 'score');
    const count = games.length;
    const best  = count ? Math.max(...games.map(g => g.score)) : null;
    const avg   = count ? (games.reduce((a, g) => a + g.score, 0) / count).toFixed(1) : null;
    res.json({ best, games: count, streak: user.streak, longest: user.longest, avg });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/api/quiz/submit', authMiddleware, async (req, res) => {
  try {
    const { score, categories } = req.body;
    if (score == null) return res.status(400).json({ error: 'Score obrigatório' });
    await Game.create({ user_id: req.user.id, username: req.user.username, score, categories: categories || [] });
    const { streak, longest } = await updateStreak(req.user.id);
    res.json({ ok: true, streak, longest });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/api/ranking/daily', async (req, res) => {
  try {
    const start = new Date(); start.setHours(0,0,0,0);
    const rows = await Game.aggregate([
      { $match: { createdAt: { $gte: start } } },
      { $group: { _id: '$user_id', username: { $first: '$username' }, best: { $max: '$score' }, games: { $sum: 1 } } },
      { $sort: { best: -1, games: -1 } }, { $limit: 20 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
      { $addFields: { streak: { $arrayElemAt: ['$u.streak', 0] } } },
      { $project: { _id: 0, username: 1, best: 1, games: 1, streak: 1 } },
    ]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/api/ranking/alltime', async (req, res) => {
  try {
    const rows = await Game.aggregate([
      { $group: { _id: '$user_id', username: { $first: '$username' }, best: { $max: '$score' }, games: { $sum: 1 } } },
      { $sort: { best: -1, games: -1 } }, { $limit: 20 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
      { $addFields: { streak: { $arrayElemAt: ['$u.streak', 0] } } },
      { $project: { _id: 0, username: 1, best: 1, games: 1, streak: 1 } },
    ]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 Rodando em http://localhost:${PORT}`));
