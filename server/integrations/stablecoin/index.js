'use strict';

const { getConfig } = require('./config');
const { BlockchainEngine } = require('./blockchainEngine');
const { TreasuryEngine, DEFAULT_ACCOUNT } = require('./treasuryEngine');
const { StablecoinGateway } = require('./stablecoinGateway');
const { MagicWalletService } = require('./magicWalletService');
const { Wso2ApiManager } = require('./wso2ApiManager');
const { SourceOfFundsAdapter } = require('./sourceOfFundsAdapter');

module.exports = {
  getConfig,
  BlockchainEngine,
  TreasuryEngine,
  DEFAULT_ACCOUNT,
  StablecoinGateway,
  MagicWalletService,
  Wso2ApiManager,
  SourceOfFundsAdapter,
};
