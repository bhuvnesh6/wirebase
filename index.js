import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import { Server } from 'socket.io';
import chalk from 'chalk';

import { connectDB } from './src/config/db.js';
import Instance from './src/models/Instance.js';
import authRoutes from './src/routes/authRoutes.js';
import instanceRoutes from './src/routes/instanceRoutes.js';
import subadminRoutes from './src/routes/subadminRoutes.js';
import apiKeyRoutes from './src/routes/apiKeyRoutes.js';
import publicRoutes from './src/routes/publicRoutes.js';
import mediaRoutes from './src/routes/mediaRoutes.js';
import { startAutoRefresh } from './src/services/proxyService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.CLIENT_ORIGIN || process.env.PUBLIC_BASE_URL || 'http://localhost:4000').split(',');

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '2mb' }));

// --- Sessions (MongoDB-backed, no JWT) ---
const sessionMiddleware = session({
  name: 'wirebase.sid',
  secret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE === 'true',
  },
});

// --- Media files: public, protected by the signed ?token=... in each URL.
// Mounted BEFORE the session middleware so file requests don't create session records. ---
app.use('/media', mediaRoutes);

app.use(sessionMiddleware);

// --- API routes ---
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/instances', instanceRoutes);
app.use('/api/subadmins', subadminRoutes);
app.use('/api/api-keys', apiKeyRoutes);
app.use('/api/public', publicRoutes); // authenticated by API key, not session - used by external integrations

// --- Frontend: HTML pages in /public, JS+CSS assets in /static ---
app.use('/static', express.static(path.join(__dirname, 'static')));
app.use(express.static(path.join(__dirname, 'public')));

// --- Socket.IO, sharing the same session as Express (so /instance pages get live QR/status/messages) ---
const io = new Server(server, { cors: { origin: allowedOrigins, credentials: true } });
app.set('io', io);
io.engine.use(sessionMiddleware);

io.on('connection', (socket) => {
  const session = socket.request.session;

  socket.on('join', async (instanceId) => {
    if (!session?.role) return;
    const filter =
      session.role === 'admin'
        ? { _id: instanceId }
        : { _id: instanceId, ownerRole: 'subadmin', ownerId: session.userId };
    const owned = await Instance.exists(filter);
    if (!owned) return; // silently ignore attempts to join instances the caller doesn't own
    socket.join(`instance:${instanceId}`);
  });

  socket.on('leave', (instanceId) => {
    socket.leave(`instance:${instanceId}`);
  });
});

const PORT = process.env.PORT || 4000;

connectDB()
  .then(() => {
    startAutoRefresh();
    server.listen(PORT, () => console.log(chalk.green(`🚀 Wirebase listening on :${PORT}`)));
  })
  .catch((err) => {
    console.error(chalk.red('Failed to start server:'), err);
    process.exit(1);
  });