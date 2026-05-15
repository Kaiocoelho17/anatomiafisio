// AnatomiaFisio — Backend Server
// Node.js + Express + SQLite (mongoose)
// Run: npm install && node server.js
// Acessa: http://localhost:3000

const express = require('express');
const Database = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'anatomia_fisio_secret_2024';

// ── MIDDLEWARE ──────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // coloque o index.html em /public

// ── BANCO DE DADOS ──────────────────────────────────────
const db = new Database('anatomia.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    username  TEXT UNIQUE NOT NULL,
    password  TEXT NOT NULL,
    is_admin  INTEGER DEFAULT 0,
    streak    INTEGER DEFAULT 0,
    longest   INTEGER DEFAULT 0,
    last_play TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    score      INTEGER NOT NULL,
    categories TEXT,
    played_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// ── HELPERS ─────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Token ausente' });
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function updateStreak(userId) {
  const user = db.prepare('SELECT streak, longest, last_play FROM users WHERE id = ?').get(userId);
  const today = todayStr();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  let newStreak = user.streak;
  if (user.last_play === today) {
    // Já jogou hoje, não muda streak
  } else if (user.last_play === yesterday) {
    newStreak = user.streak + 1;
  } else {
    newStreak = 1;
  }
  const newLongest = Math.max(newStreak, user.longest);
  db.prepare('UPDATE users SET streak = ?, longest = ?, last_play = ? WHERE id = ?')
    .run(newStreak, newLongest, today, userId);
  return { streak: newStreak, longest: newLongest };
}

// ── ROTAS ───────────────────────────────────────────────

// POST /api/register
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuário e senha obrigatórios' });
  if (username.length < 3) return res.status(400).json({ error: 'Usuário deve ter ao menos 3 caracteres' });
  if (password.length < 4) return res.status(400).json({ error: 'Senha deve ter ao menos 4 caracteres' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Usuário já existe' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hash);
  const token = jwt.sign({ id: info.lastInsertRowid, username, is_admin: 0 }, JWT_SECRET, { expiresIn: '7d' });

  res.json({ token, username, is_admin: false, streak: 0, longest: 0 });
});

// POST /api/login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuário e senha obrigatórios' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Usuário ou senha incorretos' });

  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Usuário ou senha incorretos' });

  const token = jwt.sign({ id: user.id, username: user.username, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });

  res.json({
    token,
    username: user.username,
    is_admin: !!user.is_admin,
    streak: user.streak,
    longest: user.longest
  });
});

// GET /api/me/stats
app.get('/api/me/stats', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const user = db.prepare('SELECT streak, longest FROM users WHERE id = ?').get(userId);
  const games = db.prepare('SELECT score FROM games WHERE user_id = ?').all(userId);

  const count = games.length;
  const best = count ? Math.max(...games.map(g => g.score)) : null;
  const avg = count ? (games.reduce((a, g) => a + g.score, 0) / count).toFixed(1) : null;

  res.json({
    best,
    games: count,
    streak: user.streak,
    longest: user.longest,
    avg
  });
});

// POST /api/quiz/submit
app.post('/api/quiz/submit', authMiddleware, (req, res) => {
  const { score, categories } = req.body;
  if (score == null) return res.status(400).json({ error: 'Score obrigatório' });

  db.prepare('INSERT INTO games (user_id, score, categories) VALUES (?, ?, ?)')
    .run(req.user.id, score, JSON.stringify(categories || []));

  const { streak, longest } = updateStreak(req.user.id);

  res.json({ ok: true, streak, longest });
});

// GET /api/ranking/daily
app.get('/api/ranking/daily', (req, res) => {
  const today = todayStr();
  const rows = db.prepare(`
    SELECT u.username,
           MAX(g.score) as best,
           COUNT(g.id)  as games,
           u.streak
    FROM games g
    JOIN users u ON u.id = g.user_id
    WHERE DATE(g.played_at) = ?
    GROUP BY g.user_id
    ORDER BY best DESC, games DESC
    LIMIT 20
  `).all(today);
  res.json(rows);
});

// GET /api/ranking/alltime
app.get('/api/ranking/alltime', (req, res) => {
  const rows = db.prepare(`
    SELECT u.username,
           MAX(g.score) as best,
           COUNT(g.id)  as games,
           u.streak
    FROM games g
    JOIN users u ON u.id = g.user_id
    GROUP BY g.user_id
    ORDER BY best DESC, games DESC
    LIMIT 20
  `).all();
  res.json(rows);
});

// ── FALLBACK: serve index.html para rotas não-API ───────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── INICIAR ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ AnatomiaFisio rodando em http://localhost:${PORT}`);
  console.log(`   Banco de dados: anatomia.db`);
  console.log(`   HTML: coloque o index.html dentro da pasta /public\n`);
});