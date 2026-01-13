const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

/* ================= DATABASE ================= */

const db = new Database('chat.db');

/* USERS */
db.prepare(`
CREATE TABLE IF NOT EXISTS users (
  login TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  nickname TEXT NOT NULL
)
`).run();

/* MESSAGES */
db.prepare(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fromUser TEXT NOT NULL,
  toUser TEXT NOT NULL,
  text TEXT NOT NULL,
  time INTEGER NOT NULL
)
`).run();

/* FRIENDS */
db.prepare(`
CREATE TABLE IF NOT EXISTS friends (
  user1 TEXT NOT NULL,
  user2 TEXT NOT NULL,
  UNIQUE(user1, user2)
)
`).run();

/* UNREAD MESSAGES */
db.prepare(`
CREATE TABLE IF NOT EXISTS unread (
  fromUser TEXT,
  toUser TEXT,
  count INTEGER,
  UNIQUE(fromUser, toUser)
)
`).run();

/* ================= CLIENTS ================= */
// ws -> { login, nickname }
const clients = new Map();

/* ================= HELPERS ================= */

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendToUser(login, data) {
  for (const [ws, info] of clients) {
    if (info.login === login) {
      send(ws, data);
    }
  }
}

function getFriends(login) {
  return db.prepare(`
    SELECT user1 AS friend FROM friends WHERE user2 = ?
    UNION
    SELECT user2 AS friend FROM friends WHERE user1 = ?
  `).all(login, login).map(r => r.friend);
}

function broadcastOnlineFriends() {
  for (const [ws, info] of clients) {
    const friends = getFriends(info.login);
    const online = [];

    for (const [, other] of clients) {
      if (friends.includes(other.login)) {
        online.push({
          login: other.login,
          nickname: other.nickname,
          avatar: {
            letter: other.nickname[0].toUpperCase(),
            color: avatarColor(other.login)
          }
        });
      }
    }

    send(ws, {
      type: 'online_friends',
      users: online
    });
  }
}

/* Стабильный цвет аватара */
function avatarColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${hash % 360},70%,55%)`;
}

/* ================= WEBSOCKET ================= */

wss.on('connection', ws => {
  let userLogin = null;

  ws.on('message', msg => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    /* ---------- REGISTER ---------- */
    if (data.type === 'register') {
      const { login, password } = data;

      const exists = db.prepare(
        `SELECT login FROM users WHERE login = ?`
      ).get(login);

      if (exists) {
        send(ws, { type: 'error', message: 'Логин уже занят' });
        return;
      }

      db.prepare(`
        INSERT INTO users (login, password, nickname)
        VALUES (?, ?, ?)
      `).run(login, password, login);

      send(ws, { type: 'register_ok' });
      return;
    }

    /* ---------- LOGIN ---------- */
    if (data.type === 'login') {
      const { login, password } = data;

      const user = db.prepare(`
        SELECT login, nickname FROM users
        WHERE login = ? AND password = ?
      `).get(login, password);

      if (!user) {
        send(ws, { type: 'error', message: 'Неверный логин или пароль' });
        return;
      }

      userLogin = user.login;
      clients.set(ws, user);

      send(ws, {
        type: 'login_ok',
        login: user.login,
        nickname: user.nickname,
        avatar: {
          letter: user.nickname[0].toUpperCase(),
          color: avatarColor(user.login)
        }
      });

      broadcastOnlineFriends();
      return;
    }

    /* ---------- FRIEND REQUEST ---------- */
    if (data.type === 'friend_request') {
      sendToUser(data.to, {
        ...data,
        avatar: {
          letter: data.from[0].toUpperCase(),
          color: avatarColor(data.from)
        }
      });
      return;
    }

    /* ---------- FRIEND ACCEPT ---------- */
    if (data.type === 'friend_accept') {
      db.prepare(`
        INSERT OR IGNORE INTO friends (user1, user2)
        VALUES (?, ?)
      `).run(data.from, data.to);

      sendToUser(data.to, {
        ...data,
        avatar: {
          letter: data.from[0].toUpperCase(),
          color: avatarColor(data.from)
        }
      });

      broadcastOnlineFriends();
      return;
    }

    /* ---------- MESSAGE ---------- */
    if (data.type === 'message') {
      db.prepare(`
        INSERT INTO messages (fromUser, toUser, text, time)
        VALUES (?, ?, ?, ?)
      `).run(data.from, data.to, data.text, Date.now());

      // Увеличение счётчика непрочитанных
      db.prepare(`
        INSERT INTO unread (fromUser, toUser, count)
        VALUES (?, ?, 1)
        ON CONFLICT(fromUser, toUser)
        DO UPDATE SET count = count + 1
      `).run(data.from, data.to);

      const unreadCount = db.prepare(`
        SELECT count FROM unread
        WHERE fromUser = ? AND toUser = ?
      `).get(data.from, data.to)?.count || 0;

      const msgData = {
        ...data,
        avatar: {
          letter: data.from[0].toUpperCase(),
          color: avatarColor(data.from)
        },
        unread: unreadCount
      };

      sendToUser(data.from, msgData);
      sendToUser(data.to, msgData);
    }

    /* ---------- READ ---------- */
    if (data.type === 'read') {
      db.prepare(`
        DELETE FROM unread
        WHERE fromUser = ? AND toUser = ?
      `).run(data.from, userLogin);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastOnlineFriends();
  });
});

/* ================= START ================= */
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log('✅ Server started on port', PORT);
});

