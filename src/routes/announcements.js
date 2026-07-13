const express = require('express');
const { asyncRoute, requireAuth } = require('../middleware');
const { currentAnnouncement } = require('../services/announcements');

const router = express.Router();

router.get('/current', requireAuth, asyncRoute(async (req, res) => {
  res.json({ announcement: await currentAnnouncement() });
}));

module.exports = router;
