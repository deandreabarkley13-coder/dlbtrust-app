'use strict';

/**
 * Treasury Management System — Route Index
 * Mounts all TMS sub-routers under /api/treasury
 */

const express = require('express');
const router = express.Router();

router.use('/trust', require('./trust'));
router.use('/bonds', require('./bonds'));
router.use('/beneficiaries', require('./beneficiaries'));
router.use('/distributions', require('./distributions'));
router.use('/payments', require('./payments'));
router.use('/ledger', require('./ledger'));
router.use('/wallets', require('./wallets'));
router.use('/mft', require('./mft'));
router.use('/engine', require('./payment-engine'));
router.use('/ach', require('./ach-gateway'));

module.exports = router;
