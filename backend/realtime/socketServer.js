/**
 * Real-time layer (Socket.io).
 * ==============================
 * Why push instead of the frontend polling `GET /api/alerts` on a
 * timer: a poll either lags behind (long interval) or hammers the API
 * for mostly-empty responses (short interval) — neither is what a real
 * fraud system does. Every alert/transaction is already fully scored
 * server-side the moment it's created (see models/fraudEngine.js); this
 * module just fans that same event out over a persistent connection
 * instead of making the client come back and ask for it.
 *
 * ROOMS
 * -----
 *   user:<id>        — private to that user. Their own new transactions
 *                       and alerts land here.
 *   admins            — every connected admin. Sees every user's new
 *                       transactions/alerts, mirroring the admin REST
 *                       views (`allWithUsername`).
 *   simulation-feed   — public to every authenticated socket. Carries
 *                       ONLY synthetic transactions from realtime/
 *                       simulator.js (see feature: live transaction
 *                       feed demo) — never real user financial data —
 *                       so any logged-in user can watch detection
 *                       happen without exposing anyone's real activity.
 *
 * AUTH
 * ----
 * The handshake carries the same JWT used for REST (`auth: { token }`
 * on the client). Verified once at `connect` — same secret, same
 * "user still exists" check as middleware/auth.js — then the socket is
 * bound to that user for its lifetime. No token, expired token, or
 * deleted user => connection is refused before any room is joined.
 */

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const logger = require('../config/logger');
const userRepository = require('../models/userRepository');

let io = null;

function userRoom(userId) {
  return `user:${userId}`;
}

async function authenticateSocket(socket, next) {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No token provided'));

    const decoded = jwt.verify(token, config.jwtSecret);
    // Only the short-lived access JWT is valid here — same reasoning as
    // middleware/auth.js's authMiddleware.
    if (decoded.type !== 'access') return next(new Error('Invalid or expired token'));

    const user = await userRepository.findById(decoded.id);
    if (!user) return next(new Error('User not found'));

    socket.user = user;
    next();
  } catch (err) {
    next(new Error('Invalid or expired token'));
  }
}

function initSocketServer(httpServer) {
  const { Server } = require('socket.io');
  io = new Server(httpServer, {
    // Same allow-list as the REST API's CORS config (server.js) — no
    // wildcard, see config/env.js's CORS_ALLOWED_ORIGINS.
    cors: { origin: config.corsAllowedOrigins, credentials: true },
  });

  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    const { id, username, role } = socket.user;

    socket.join(userRoom(id));
    socket.join('simulation-feed');
    if (role === 'admin') socket.join('admins');

    logger.info('Socket connected', { userId: id, username, socketId: socket.id });

    socket.on('disconnect', (reason) => {
      logger.info('Socket disconnected', { userId: id, username, socketId: socket.id, reason });
    });
  });

  logger.info('Socket.io server initialized');
  return io;
}

function getIO() {
  return io;
}

/**
 * Fan a newly-scored transaction out to its owner and to admins.
 * `source` distinguishes a real submission from routes/transactions.js
 * ('live') from a synthetic one from realtime/simulator.js ('simulation')
 * — the frontend uses it to label the event, not to gate delivery.
 */
function emitTransactionCreated(transaction, { source = 'live' } = {}) {
  if (!io) return;
  const payload = { transaction, source };
  io.to(userRoom(transaction.user_id)).emit('transaction:new', payload);
  io.to('admins').emit('transaction:new', payload);
}

/** Fan a newly-created alert out to its owner and to admins. */
function emitAlertCreated(alert, { source = 'live' } = {}) {
  if (!io) return;
  const payload = { alert, source };
  io.to(userRoom(alert.user_id)).emit('alert:new', payload);
  io.to('admins').emit('alert:new', payload);
}

/**
 * Broadcast a synthetic transaction (+ its analysis) to the public
 * simulation-feed room only. Real per-user/admin delivery for the same
 * synthetic transaction still happens via emitTransactionCreated/
 * emitAlertCreated above, so a simulated user's own dashboard reacts
 * exactly like it would to a real transaction.
 */
function emitSimulationTransaction(payload) {
  if (!io) return;
  io.to('simulation-feed').emit('simulation:transaction', payload);
}

function emitSimulationStatus(status) {
  if (!io) return;
  io.to('simulation-feed').emit('simulation:status', status);
}

module.exports = {
  initSocketServer,
  getIO,
  emitTransactionCreated,
  emitAlertCreated,
  emitSimulationTransaction,
  emitSimulationStatus,
};
