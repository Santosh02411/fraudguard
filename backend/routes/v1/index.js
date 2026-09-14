const express = require('express');
const config = require('../../config/env');

const router = express.Router();

router.use('/auth', require('../auth'));
router.use('/transactions', require('../transactions'));
router.use('/alerts', require('../alerts'));
router.use('/admin', require('../admin'));
router.use('/api-keys', require('../apiKeys'));
router.use('/webhooks', require('../webhooks'));
router.use('/disputes', require('../disputes'));

// GET /api/v1/health (also reachable, unversioned, at /api/health — see server.js)
router.get('/health', (req, res) => res.json({
  status: 'ok',
  env: config.env,
  api_version: 'v1',
  time: new Date().toISOString(),
}));

module.exports = router;
