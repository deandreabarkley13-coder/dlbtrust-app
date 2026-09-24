'use strict';

/**
 * ACH Engine — orchestrates NACHA file generation, batch tracking, and AS2 transmission.
 * PostgreSQL-backed via fineract_tenants pool.
 */

const pool = require('../bonds/pgPool');
const { generateNACHAFile, parseNACHAFile, validateRouting, sameDayDescriptiveDate, SAME_DAY_ACH_ENTRY_LIMIT_CENTS, ODFI_ROUTING, ORIGINATOR_ID } = require('./nachaGenerator');
const { AS2Client } = require('./as2Client');
const { AS2Partners } = require('./as2Partners');
const { OpenBankApi } = require('./openBankApi');
const path = require('path');
const fs = require('fs');

const ACH_FILES_DIR = process.env.ACH_FILES_DIR || path.join(__dirname, '..', '..', '..', 'data', 'ach-files');
// Same Day ACH: the ODFI's last same-day submission cutoff, Eastern time (Fed final window closes 16:45 ET).
const SAME_DAY_CUTOFF_ET = process.env.ACH_SAME_DAY_CUTOFF_ET || '16:45';
const ET_ZONE = 'America/New_York';

function easternParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: ET_ZONE, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, hhmm: `${parts.hour}:${parts.minute}` };
}

let sameDayColumnReady = null;

class ACHEngine {
  /**
   * Ensure the ach-files directory exists.
   */
  static ensureFilesDir() {
    if (!fs.existsSync(ACH_FILES_DIR)) {
      fs.mkdirSync(ACH_FILES_DIR, { recursive: true });
    }
  }

  /**
   * Create a new ACH batch from pending entries.
   * Each entry: { receivingRouting, accountNumber, amountCents, transactionCode,
   *               individualId, individualName, secCode, memo }
   *
   * @param {Object} opts - { effectiveDate, secCode, description, createdBy, sameDay, companyDescriptiveDate }
   *   sameDay: originate as Same Day ACH — effective entry date is forced to the
   *   current banking day (ET), every entry must be within the NACHA same-day
   *   per-entry limit, and the batch is flagged `same_day` for the ODFI window.
   * @param {Array} entries - payment entries
   * @returns {Object} batch record with generated NACHA content
   */
  static async createBatch(opts = {}, entries = []) {
    if (!entries.length) throw new Error('At least one entry is required');

    const sameDay = Boolean(opts.sameDay);
    let sameDayWindow = null;
    if (sameDay) {
      sameDayWindow = ACHEngine.sameDayWindow();
      if (!sameDayWindow.bankingDay) {
        throw Object.assign(new Error(`Same Day ACH requires a banking day; ${sameDayWindow.date} (${sameDayWindow.weekday} ET) is not one`), { code: 'ACH_SAME_DAY_NOT_BANKING_DAY' });
      }
      if (opts.effectiveDate && opts.effectiveDate !== sameDayWindow.date) {
        throw Object.assign(new Error(`Same Day ACH effective date must be the current banking day ${sameDayWindow.date}, got ${opts.effectiveDate}`), { code: 'ACH_SAME_DAY_EFFECTIVE_DATE' });
      }
      for (const entry of entries) {
        if (Number(entry.amountCents) > SAME_DAY_ACH_ENTRY_LIMIT_CENTS) {
          throw Object.assign(new Error(`Same Day ACH per-entry limit is $${(SAME_DAY_ACH_ENTRY_LIMIT_CENTS / 100).toLocaleString('en-US')}; entry of ${(Number(entry.amountCents) / 100).toFixed(2)} exceeds it`), { code: 'ACH_SAME_DAY_LIMIT_EXCEEDED' });
        }
      }
    }

    for (const entry of entries) {
      if (!entry.receivingRouting || !entry.accountNumber || !entry.amountCents) {
        throw new Error('Each entry requires receivingRouting, accountNumber, amountCents');
      }
      if (!validateRouting(String(entry.receivingRouting))) {
        throw new Error(`Invalid routing number: ${entry.receivingRouting}`);
      }
    }

    const batchId = 'ACH-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const effectiveDate = sameDay ? sameDayWindow.date : (opts.effectiveDate || new Date().toISOString().split('T')[0]);
    const secCode = opts.secCode || 'CCD';
    const description = opts.description || 'PAYMENT';
    const companyDescriptiveDate = opts.companyDescriptiveDate || (sameDay ? sameDayDescriptiveDate() : undefined);

    const nachaContent = generateNACHAFile({}, [{
      secCode,
      companyEntryDescription: description,
      effectiveEntryDate: effectiveDate,
      companyDescriptiveDate,
      serviceClassCode: '200',
      entries: entries.map(e => ({
        receivingRouting: e.receivingRouting,
        accountNumber: e.accountNumber,
        amountCents: e.amountCents,
        transactionCode: e.transactionCode || '22',
        individualId: e.individualId || '',
        individualName: e.individualName || '',
      })),
    }]);

    const totalCents = entries.reduce((sum, e) => sum + Number(e.amountCents), 0);
    const filename = `${batchId}.ach`;

    // Save to filesystem
    ACHEngine.ensureFilesDir();
    const filePath = path.join(ACH_FILES_DIR, filename);
    fs.writeFileSync(filePath, nachaContent);

    // Save to database (with optional partner_id for multi-partner routing)
    await ACHEngine.ensureSameDayColumn();
    const result = await pool.query(
      `INSERT INTO ach_batches
        (batch_id, filename, status, sec_code, entry_description,
         effective_date, entry_count, total_amount_cents, nacha_content,
         file_path, created_by, partner_id, same_day, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       RETURNING *`,
      [batchId, filename, 'pending', secCode, description,
       effectiveDate, entries.length, totalCents, nachaContent,
       filePath, opts.createdBy || 'system', opts.partnerId || null, sameDay]
    );

    // Save individual entries
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      await pool.query(
        `INSERT INTO ach_entries
          (batch_id, entry_sequence, transaction_code, receiving_routing,
           account_number, amount_cents, individual_id, individual_name, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [batchId, i + 1, e.transactionCode || '22', e.receivingRouting,
         e.accountNumber, e.amountCents, e.individualId || '',
         e.individualName || '', e.memo || '']
      );
    }

    const row = result.rows[0];
    return sameDay ? { ...row, same_day_window: sameDayWindow } : row;
  }

  /**
   * Same Day ACH window in Eastern time: the current banking day and whether
   * the ODFI's last same-day submission cutoff (ACH_SAME_DAY_CUTOFF_ET) has passed.
   * Weekends are refused; Federal Reserve holidays are the ODFI's call.
   */
  static sameDayWindow(now = new Date()) {
    const et = easternParts(now);
    const bankingDay = !['Sat', 'Sun'].includes(et.weekday);
    return {
      date: et.date,
      weekday: et.weekday,
      nowEt: et.hhmm,
      cutoffEt: SAME_DAY_CUTOFF_ET,
      bankingDay,
      withinWindow: bankingDay && et.hhmm < SAME_DAY_CUTOFF_ET,
      entryLimitCents: SAME_DAY_ACH_ENTRY_LIMIT_CENTS,
    };
  }

  static ensureSameDayColumn() {
    if (!sameDayColumnReady) {
      sameDayColumnReady = pool.query('ALTER TABLE ach_batches ADD COLUMN IF NOT EXISTS same_day BOOLEAN NOT NULL DEFAULT FALSE')
        .catch((e) => { sameDayColumnReady = null; throw e; });
    }
    return sameDayColumnReady;
  }

  /**
   * Get a batch by ID.
   */
  static async getBatch(batchId) {
    const batch = await pool.query('SELECT * FROM ach_batches WHERE batch_id = $1', [batchId]);
    if (!batch.rows.length) return null;

    const entries = await pool.query(
      'SELECT * FROM ach_entries WHERE batch_id = $1 ORDER BY entry_sequence',
      [batchId]
    );

    return { ...batch.rows[0], entries: entries.rows };
  }

  /**
   * List batches with optional filters.
   */
  static async listBatches({ status, fromDate, toDate, limit = 50, offset = 0 } = {}) {
    let sql = 'SELECT * FROM ach_batches WHERE 1=1';
    const params = [];
    let idx = 1;

    if (status) {
      sql += ` AND status = $${idx++}`;
      params.push(status);
    }
    if (fromDate) {
      sql += ` AND created_at >= $${idx++}`;
      params.push(fromDate);
    }
    if (toDate) {
      sql += ` AND created_at <= $${idx++}`;
      params.push(toDate);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await pool.query(sql, params);
    return result.rows;
  }

  /**
   * Transmit a batch via AS2 to the bank.
   * Looks up batch.partner_id to route to the correct AS2 partner.
   * Falls back to default partner or global AS2_CONFIG if no partner_id.
   */
  static async transmitBatch(batchId, { approvedBy = null, actor = null } = {}) {
    const batch = await ACHEngine.getBatch(batchId);
    if (!batch) throw new Error(`Batch not found: ${batchId}`);
    const nonTransmittable = ['transmitting', 'transmitted', 'accepted', 'settled', 'returned', 'cancelled'];
    if (nonTransmittable.includes(batch.status)) {
      throw new Error(`Cannot transmit batch in '${batch.status}' status — only 'pending' or 'failed' batches can be transmitted`);
    }

    const nachaContent = batch.nacha_content;
    if (!nachaContent) throw new Error('Batch has no NACHA content');

    // Third-Party Sender preflight: ODFI agreement, approved Originator, limits, return rates.
    // Advisory unless TPS_OS_ENFORCE=true, in which case a blocked preflight refuses transmission.
    const { TpsOsEngine } = require('../os/thirdPartySenderOsEngine');
    let tpsPreflight = null;
    try {
      tpsPreflight = await TpsOsEngine.gateTransmission(batch, { actor: actor || approvedBy });
    } catch (e) {
      if (e.code === 'TPS_PREFLIGHT_BLOCKED') throw e;
      console.warn(`[ACH] transmitBatch(${batchId}): TPS preflight unavailable — ${e.message}`);
    }
    if (tpsPreflight && !tpsPreflight.allowed) {
      console.warn(`[ACH] transmitBatch(${batchId}): TPS preflight advisory blockers — ${tpsPreflight.blockers.join('; ')}`);
    }

    // Check system mode — production routes to configured external bank endpoint
    const { SystemSettings } = require('./systemSettings');
    const systemMode = await SystemSettings.getMode();
    const productionConfig = systemMode === 'production'
      ? await SystemSettings.getProductionPartnerConfig()
      : null;

    // Resolve partner config for this batch
    let partnerConfig = null;
    if (ACHEngine.mftChannelId()) {
      // The MFT register: one file channel under every rail, in every mode.
      // It keeps the bytes, the hash and the release decision, so it wins
      // over any bare endpoint.
      partnerConfig = ACHEngine.mftPartnerConfig();
    } else if (systemMode === 'production' && ACHEngine.odfiApiPartnerConfig()) {
      // Bank-as-API ODFI (Increase / Column): the funded origination account
      // that executes credits on FedACH. Wins over file channels because it is
      // the only channel that can confirm real dollars left the account.
      partnerConfig = ACHEngine.odfiApiPartnerConfig();
    } else if (systemMode === 'production' && ACHEngine.mftGatewayPartnerConfig()) {
      // Hosted AS2 station on MFT Gateway delivering to the bank's registered
      // partner profile — the ODFI channel for treasury -> RDFI credits.
      // Production only: sandbox never leaves the platform through the gateway.
      partnerConfig = ACHEngine.mftGatewayPartnerConfig();
    } else if (systemMode === 'production' && ACHEngine.openAchPartnerConfig()) {
      // The trust's own ODFI origination platform (OpenACH, in-project on GCP):
      // holds the treasury origination account, so entries are originated
      // there rather than dropped as a file.
      partnerConfig = ACHEngine.openAchPartnerConfig();
    } else if (productionConfig) {
      // Production mode: use the configured external bank endpoint
      partnerConfig = productionConfig;
      console.log(`[ACH] transmitBatch(${batchId}): PRODUCTION MODE → ${productionConfig.partnerName}`);
    } else {
      // Sandbox mode: use partner-specific or default config
      if (batch.partner_id) {
        partnerConfig = await AS2Partners.getPartnerConfig(batch.partner_id);
      }
      if (!partnerConfig) {
        partnerConfig = await AS2Partners.getDefaultPartnerConfig();
      }

      // Env-driven SFTP endpoint (the bank's NACHA drop) — used when no explicit
      // partner is configured, so deposits auto-deliver machine-to-machine over SFTP.
      if (!partnerConfig && process.env.ACH_SFTP_URL) {
        partnerConfig = {
          partnerId: process.env.ACH_SFTP_PARTNER_ID || 'BANK-SFTP',
          partnerName: process.env.ACH_SFTP_PARTNER_NAME || 'Bank NACHA SFTP',
          protocol: 'rest_api', // OpenBankApi.transmit routes sftp:// URLs to SFTP
          apiBaseUrl: process.env.ACH_SFTP_URL, // sftp://user@host:port/incoming
          apiSecret: process.env.ACH_SFTP_KEY || null, // private key file path
          apiKey: process.env.ACH_SFTP_PASSWORD || null, // or password
        };
      }

      // When no partner is configured, default to HTTPS REST API self-transmit
      if (!partnerConfig) {
        partnerConfig = {
          partnerId: batch.partner_id || 'DLBTRUST-DIRECT',
          partnerName: 'DLB Trust Direct',
          protocol: 'rest_api',
          apiBaseUrl: 'direct',
          localAs2Id: 'DLBTRUST-AS2',
        };
      }
    }

    // Update status to transmitting
    console.log(`[ACH] transmitBatch(${batchId}): partner=${partnerConfig.partnerId}, protocol=${partnerConfig.protocol}, mode=${systemMode}`);
    await pool.query(
      `UPDATE ach_batches SET status = 'transmitting', updated_at = NOW() WHERE batch_id = $1`,
      [batchId]
    );

    try {
      // Route based on partner protocol: bill_api, rest_api, or as2
      const protocol = partnerConfig.protocol || 'rest_api';
      console.log(`[ACH] transmitBatch(${batchId}): calling ${protocol} transmit`);

      let result;
      if (protocol === 'mft') {
        const { MftOsEngine } = require('../os/mftOsEngine');
        const delivered = await MftOsEngine.deliver({
          channelId: partnerConfig.mftChannelId || ACHEngine.mftChannelId(),
          format: 'nacha',
          content: nachaContent,
          filename: batch.filename,
          sourceRef: `ach:${batchId}`,
          builtBy: batch.created_by || 'system',
          approvedBy: approvedBy || null,
          memo: batch.entry_description || null,
          actor: actor || approvedBy || batch.created_by || 'ach-engine',
        });
        const file = delivered.file;
        result = {
          success: true,
          mode: 'mft',
          message_id: file.fileId,
          status_code: 200,
          mdn_received: false,
          response_body: JSON.stringify({ fileId: file.fileId, filename: file.filename, remotePath: file.remotePath, transport: file.transport, contentHash: file.contentHash, replay: delivered.replay }),
          mftFile: file,
          replay: delivered.replay,
        };
        console.log(`[ACH] transmitBatch(${batchId}): MFT → ${file.fileId} on ${file.transport} (${delivered.replay ? 'replay' : 'transmitted'})`);
      } else if (protocol === 'mftgateway') {
        const { MftGatewayClient } = require('../edi/mftGatewayClient');
        const sent = await MftGatewayClient.submit(nachaContent, batch.filename, {
          stationAs2Id: partnerConfig.localAs2Id,
          partnerAs2Id: partnerConfig.partnerAs2Id,
          contentType: 'text/plain',
          subject: `NACHA ${batch.filename}`,
        });
        if (!sent.success) {
          throw new Error(`MFT Gateway submit failed (${sent.status_code}): ${sent.response_body || 'no response'}`);
        }
        result = {
          success: true,
          mode: 'mftgateway',
          message_id: sent.message_id || ('MFTG-' + Date.now()),
          status_code: sent.status_code,
          mdn_received: false,
          response_body: JSON.stringify({ as2_from: sent.as2_from, as2_to: sent.as2_to, message_id: sent.message_id, link: sent.link, response: sent.response_body }),
        };
        console.log(`[ACH] transmitBatch(${batchId}): MFT Gateway → ${sent.as2_to} message=${sent.message_id}`);
      } else if (protocol === 'odfi_api') {
        const { OdfiApiConnectorEngine } = require('./odfiApiConnectorEngine');
        result = await OdfiApiConnectorEngine.originateBatch(batch);
        console.log(`[ACH] transmitBatch(${batchId}): ODFI API ${partnerConfig.provider} → ${result.message_id} (${result.odfi.transfers.length} transfers)`);
      } else if (protocol === 'openach') {
        result = await ACHEngine._originateOnOpenAch(batch, partnerConfig);
        console.log(`[ACH] transmitBatch(${batchId}): OpenACH → ${result.message_id} (${result.openach.entries.length} entries)`);
      } else if (protocol === 'bill_api') {
        // BILL Cash Account: submit via BILL's RecordARPayment API
        const billClient = require('../bill/billClient');
        const totalDollars = (batch.total_amount_cents || 0) / 100;
        const billResult = await billClient.recordDeposit({
          amount: totalDollars,
          method: 'ach',
          memo: batch.entry_description || ('ACH batch ' + batchId),
        });
        result = {
          success: true,
          mode: 'bill_api',
          message_id: billResult.receivedPayId || ('BILL-' + Date.now()),
          status_code: 200,
          mdn_received: true,
          response_body: JSON.stringify(billResult),
          billRecord: billResult,
        };
        console.log(`[ACH] transmitBatch(${batchId}): BILL API → receivedPayId=${billResult.receivedPayId}`);
      } else {
        result = protocol === 'rest_api'
          ? await OpenBankApi.transmit(nachaContent, batch.filename, partnerConfig)
          : await AS2Client.transmit(nachaContent, batch.filename, partnerConfig);
      }

      console.log(`[ACH] transmitBatch(${batchId}): transmit result success=${result.success}, mode=${result.mode}`);

      // Record transmission with system mode
      await pool.query(
        `INSERT INTO ach_transmissions
          (batch_id, transmission_id, message_id, status_code,
           mdn_received, response_body, transmitted_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [batchId,
         'TX-' + Date.now(),
         result.message_id,
         result.status_code,
         result.mdn_received,
         result.response_body || '']
      );

      const newStatus = result.success ? 'transmitted' : 'failed';
      await pool.query(
        `UPDATE ach_batches SET status = $1, transmitted_at = NOW(), updated_at = NOW() WHERE batch_id = $2`,
        [newStatus, batchId]
      );

      // Update entry statuses on successful transmission
      if (result.success) {
        await pool.query(
          `UPDATE ach_entries SET status = 'transmitted' WHERE batch_id = $1 AND status = 'pending'`,
          [batchId]
        );

        // In PRODUCTION mode: do NOT auto-accept — wait for external bank confirmation
        // In SANDBOX mode: auto-accept on self-transmit
        if (systemMode === 'production') {
          console.log(`[ACH] transmitBatch(${batchId}): PRODUCTION — transmitted to external bank, awaiting confirmation`);
          const autoSettle = await SystemSettings.get('auto_settle');
          if (autoSettle === 'true') {
            // Auto-settle in production for systems that process end-to-end
            console.log(`[ACH] transmitBatch(${batchId}): auto_settle enabled → accepting`);
            await pool.query(
              `UPDATE ach_batches SET status = 'accepted', accepted_at = NOW(), updated_at = NOW() WHERE batch_id = $1`,
              [batchId]
            );
            await pool.query(
              `UPDATE ach_entries SET status = 'accepted' WHERE batch_id = $1 AND status = 'transmitted'`,
              [batchId]
            );
            return { ...result, batch_id: batchId, batch_status: 'accepted', auto_accepted: true, system_mode: 'production' };
          }
          return { ...result, batch_id: batchId, batch_status: 'transmitted', system_mode: 'production', awaiting_confirmation: true };
        }

        // Sandbox: Auto-accept on self-transmit
        const isSelfTransmit = result.mode === 'remote' && partnerConfig.partnerId === 'DLBTRUST-DIRECT';
        if (isSelfTransmit) {
          console.log(`[ACH] transmitBatch(${batchId}): self-transmit success → auto-accepting`);
          await pool.query(
            `UPDATE ach_batches SET status = 'accepted', accepted_at = NOW(), updated_at = NOW() WHERE batch_id = $1`,
            [batchId]
          );
          await pool.query(
            `UPDATE ach_entries SET status = 'accepted' WHERE batch_id = $1 AND status = 'transmitted'`,
            [batchId]
          );
          return { ...result, batch_id: batchId, batch_status: 'accepted', auto_accepted: true, system_mode: 'sandbox' };
        }
      }

      return { ...result, batch_id: batchId, batch_status: newStatus, system_mode: systemMode };
    } catch (err) {
      console.error(`[ACH] transmitBatch(${batchId}) FAILED:`, err.message);
      await pool.query(
        `UPDATE ach_batches SET status = 'failed', error_message = $1, updated_at = NOW() WHERE batch_id = $2`,
        [err.message, batchId]
      ).catch(e => console.error(`[ACH] Failed to set batch status to failed:`, e.message));
      throw err;
    }
  }

  /** Bank-as-API ODFI channel (odfiApiConnectorEngine.js), or null when not configured. */
  static odfiApiPartnerConfig() {
    try {
      const { OdfiApiConnectorEngine } = require('./odfiApiConnectorEngine');
      return OdfiApiConnectorEngine.partnerConfig();
    } catch (e) {
      return null;
    }
  }

  /** The MFT channel ACH files travel on, if the trust has pointed ACH at the register. */
  static mftChannelId() {
    return String(process.env.ACH_MFT_CHANNEL || '').trim();
  }

  static mftPartnerConfig() {
    const channelId = ACHEngine.mftChannelId();
    return {
      partnerId: `MFT:${channelId}`,
      partnerName: `MFT register (${channelId})`,
      protocol: 'mft',
      mftChannelId: channelId,
    };
  }

  /**
   * MFT Gateway (api.mftgateway.com) as the ODFI channel: our hosted AS2
   * station sends to the bank's partner profile named by
   * MFTGATEWAY_PARTNER_AS2_ID. Null until the token pair + a partner distinct
   * from our own station are configured.
   */
  static mftGatewayPartnerConfig() {
    let MftGatewayClient;
    try { ({ MftGatewayClient } = require('../edi/mftGatewayClient')); } catch (e) { return null; }
    if (!MftGatewayClient.configured()) return null;
    const cfg = MftGatewayClient.getConfig();
    // Explicit only: the EDI 820 receiver fallback is a remittance counterparty, not the ODFI.
    const partner = String(process.env.MFTGATEWAY_PARTNER_AS2_ID || '').trim();
    if (!partner || partner.toUpperCase() === String(cfg.stationAs2Id).toUpperCase()) return null;
    return {
      partnerId: `MFTGATEWAY:${partner}`,
      partnerName: process.env.MFTGATEWAY_PARTNER_NAME || `MFT Gateway partner ${partner}`,
      protocol: 'mftgateway',
      localAs2Id: cfg.stationAs2Id,
      partnerAs2Id: partner,
      partnerUrl: cfg.apiUrl,
    };
  }

  /**
   * OpenACH (the trust's ODFI origination platform) as the ODFI channel.
   * Null until the rail is configured (OPENACH_BASE_URL, API token/key and a
   * payment type id) or when OPENACH_ODFI_ENABLED=false.
   */
  static openAchPartnerConfig() {
    if (['0', 'false', 'no', 'off'].includes(String(process.env.OPENACH_ODFI_ENABLED || '').toLowerCase())) return null;
    let readiness;
    let config;
    try {
      const { getOpenAchRailConfig, openAchRailReadiness } = require('../openach/openachRailConfig');
      readiness = openAchRailReadiness();
      config = getOpenAchRailConfig();
    } catch (e) {
      return null;
    }
    if (!readiness.ready) return null;
    return {
      partnerId: 'OPENACH',
      partnerName: process.env.OPENACH_ODFI_NAME || 'OpenACH ODFI origination',
      protocol: 'openach',
      apiBaseUrl: config.baseUrl,
      paymentTypeId: config.paymentTypeIds.ach_standard,
      sameDayPaymentTypeId: config.paymentTypeIds.ach_same_day,
    };
  }

  /**
   * Originate every credit entry of a batch on OpenACH. Debit entries are
   * refused: the origination account is the trust's and this channel only
   * pushes funds out of it.
   */
  static async _originateOnOpenAch(batch, partnerConfig) {
    const { OpenACHClient } = require('../openach/openachClient');
    const entries = Array.isArray(batch.entries) && batch.entries.length
      ? batch.entries
      : (await pool.query('SELECT * FROM ach_entries WHERE batch_id = $1 ORDER BY entry_sequence', [batch.batch_id])).rows;
    if (!entries.length) throw new Error(`Batch ${batch.batch_id} has no entries to originate`);
    const debit = entries.find(e => !['22', '32', '23', '33'].includes(String(e.transaction_code || '22')));
    if (debit) throw new Error(`OpenACH ODFI channel originates credits only; entry ${debit.entry_sequence} has transaction code ${debit.transaction_code}`);

    const sendDate = batch.effective_date
      ? new Date(batch.effective_date).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const originated = [];
    for (const entry of entries) {
      const name = String(entry.individual_name || 'BENEFICIARY').trim();
      const [first, ...rest] = name.split(/\s+/);
      const res = await OpenACHClient.disburseToBeneficiary({
        first_name: first || name,
        last_name: rest.join(' ') || first || name,
        email: process.env.OPENACH_BENEFICIARY_EMAIL || `${String(entry.individual_id || entry.entry_sequence).replace(/[^a-z0-9]/gi, '')}@${process.env.OPENACH_BENEFICIARY_EMAIL_DOMAIN || 'ach.dlbtrust.local'}`,
        external_id: `${batch.batch_id}:${entry.entry_sequence}`,
        bank_name: entry.receiving_bank || 'RDFI',
        routing_number: entry.receiving_routing,
        account_number: entry.account_number,
        account_type: ['32', '33'].includes(String(entry.transaction_code)) ? 'Savings' : 'Checking',
        amount: (Number(entry.amount_cents) / 100).toFixed(2),
        send_date: sendDate,
        payment_type_id: partnerConfig.paymentTypeId,
      });
      if (!res || !res.success) throw new Error(`OpenACH origination failed for entry ${entry.entry_sequence}: ${(res && res.error) || 'unknown'}`);
      originated.push({ entry_sequence: entry.entry_sequence, payment_schedule_id: res.payment_schedule_id, external_account_id: res.external_account_id, amount: res.amount, send_date: res.send_date });
    }
    const messageId = `OPENACH-${batch.batch_id}`;
    return {
      success: true,
      mode: 'openach',
      message_id: messageId,
      status_code: 200,
      mdn_received: false,
      response_body: JSON.stringify({ base_url: partnerConfig.apiBaseUrl, payment_type_id: partnerConfig.paymentTypeId, entries: originated }),
      openach: { entries: originated },
    };
  }

  /**
   * Transition a batch to 'accepted' after bank acknowledgement.
   */
  static async acceptBatch(batchId, metadata = {}) {
    const batch = await ACHEngine.getBatch(batchId);
    if (!batch) throw new Error(`Batch not found: ${batchId}`);
    if (batch.status !== 'transmitted') {
      throw new Error(`Batch must be in 'transmitted' status to accept, current: ${batch.status}`);
    }

    await pool.query(
      `UPDATE ach_batches SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
       WHERE batch_id = $1`,
      [batchId]
    );

    // Update entry statuses
    await pool.query(
      `UPDATE ach_entries SET status = 'accepted' WHERE batch_id = $1 AND status = 'transmitted'`,
      [batchId]
    );

    // Record acknowledgement (best-effort — don't fail the accept if ack insert has constraint issues)
    if (!metadata.skipAckRecord && (metadata.transmissionId || metadata.messageId)) {
      const validAckTypes = ['mdn', 'file_ack', 'bank_ack'];
      const ackType = validAckTypes.includes(metadata.ackType) ? metadata.ackType : 'bank_ack';
      try {
        await pool.query(
          `INSERT INTO ach_acknowledgements
            (batch_id, transmission_id, ack_type, ack_status, message_id, raw_response, disposition, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
          [batchId, metadata.transmissionId || null, ackType,
           'accepted', metadata.messageId || null,
           metadata.rawResponse || null, metadata.disposition || null]
        );
      } catch (ackErr) {
        console.warn(`[ACH] acceptBatch(${batchId}): ack record insert failed (non-fatal):`, ackErr.message);
      }
    }

    const updated = await pool.query('SELECT * FROM ach_batches WHERE batch_id = $1', [batchId]);
    return updated.rows[0];
  }

  /**
   * Transition a batch to 'settled' after bank confirms settlement.
   */
  static async settleBatch(batchId, metadata = {}) {
    const batch = await ACHEngine.getBatch(batchId);
    if (!batch) throw new Error(`Batch not found: ${batchId}`);
    if (batch.status !== 'accepted' && batch.status !== 'transmitted') {
      throw new Error(`Batch must be in 'accepted' or 'transmitted' status to settle, current: ${batch.status}`);
    }

    const settlementDate = metadata.settlementDate || new Date().toISOString().split('T')[0];

    await pool.query(
      `UPDATE ach_batches
       SET status = 'settled', settled_at = NOW(), settlement_date = $2, updated_at = NOW()
       WHERE batch_id = $1`,
      [batchId, settlementDate]
    );

    // Update entry statuses
    await pool.query(
      `UPDATE ach_entries SET status = 'settled', settled_at = NOW()
       WHERE batch_id = $1 AND status IN ('transmitted', 'accepted')`,
      [batchId]
    );

    const updated = await pool.query('SELECT * FROM ach_batches WHERE batch_id = $1', [batchId]);
    return updated.rows[0];
  }

  /**
   * Process an ACH return for individual entries in a batch.
   * Marks affected entries with return codes and transitions batch if all entries returned.
   *
   * @param {string} batchId
   * @param {Array} returnEntries - [{ entrySequence|traceNumber, returnCode, returnReason, returnAmountCents, returnDate, addendaInfo }]
   * @param {Object} metadata - { returnFileRef }
   */
  static async processReturns(batchId, returnEntries = [], metadata = {}) {
    const batch = await ACHEngine.getBatch(batchId);
    if (!batch) throw new Error(`Batch not found: ${batchId}`);
    if (!['transmitted', 'accepted', 'settled'].includes(batch.status)) {
      throw new Error(`Batch must be in transmitted/accepted/settled to process returns, current: ${batch.status}`);
    }
    if (!returnEntries.length) throw new Error('At least one return entry is required');

    const processedReturns = [];

    for (const ret of returnEntries) {
      // Find the matching entry
      let entryRow;
      if (ret.traceNumber) {
        const r = await pool.query(
          'SELECT * FROM ach_entries WHERE batch_id = $1 AND trace_number = $2',
          [batchId, ret.traceNumber]
        );
        entryRow = r.rows[0];
      }
      if (!entryRow && ret.entrySequence) {
        const r = await pool.query(
          'SELECT * FROM ach_entries WHERE batch_id = $1 AND entry_sequence = $2',
          [batchId, ret.entrySequence]
        );
        entryRow = r.rows[0];
      }

      const entryId = entryRow ? entryRow.id : null;

      // Insert return record
      const returnResult = await pool.query(
        `INSERT INTO ach_returns
          (batch_id, entry_id, original_trace, return_code, return_reason,
           return_amount_cents, return_date, addenda_info, return_file_ref, processed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()) RETURNING *`,
        [batchId, entryId, ret.traceNumber || null, ret.returnCode, ret.returnReason,
         ret.returnAmountCents || (entryRow ? entryRow.amount_cents : null),
         ret.returnDate || new Date().toISOString().split('T')[0],
         ret.addendaInfo || null, metadata.returnFileRef || null]
      );
      processedReturns.push(returnResult.rows[0]);

      // Update entry with return info
      if (entryId) {
        await pool.query(
          `UPDATE ach_entries
           SET status = 'returned', return_code = $2, return_reason = $3, returned_at = NOW()
           WHERE id = $1`,
          [entryId, ret.returnCode, ret.returnReason]
        );
      }
    }

    // Check if all entries are now returned — if so, mark batch as returned
    const remaining = await pool.query(
      `SELECT COUNT(*) as count FROM ach_entries WHERE batch_id = $1 AND status != 'returned'`,
      [batchId]
    );
    const allReturned = parseInt(remaining.rows[0].count, 10) === 0;

    if (allReturned) {
      await pool.query(
        `UPDATE ach_batches
         SET status = 'returned', returned_at = NOW(),
             return_code = $2, return_reason = $3, updated_at = NOW()
         WHERE batch_id = $1`,
        [batchId, returnEntries[0].returnCode, returnEntries[0].returnReason]
      );
    } else {
      await pool.query(
        `UPDATE ach_batches SET updated_at = NOW() WHERE batch_id = $1`,
        [batchId]
      );
    }

    const updatedBatch = await pool.query('SELECT * FROM ach_batches WHERE batch_id = $1', [batchId]);
    return {
      batch: updatedBatch.rows[0],
      returns_processed: processedReturns.length,
      all_entries_returned: allReturned,
      returns: processedReturns,
    };
  }

  /**
   * Get returns for a batch.
   */
  static async getReturns(batchId) {
    const result = await pool.query(
      'SELECT * FROM ach_returns WHERE batch_id = $1 ORDER BY processed_at DESC',
      [batchId]
    );
    return result.rows;
  }

  /**
   * Get acknowledgements for a batch.
   */
  static async getAcknowledgements(batchId) {
    const result = await pool.query(
      'SELECT * FROM ach_acknowledgements WHERE batch_id = $1 ORDER BY received_at DESC',
      [batchId]
    );
    return result.rows;
  }

  /**
   * Get entry-level status for a batch.
   */
  static async getEntryStatuses(batchId) {
    const result = await pool.query(
      `SELECT e.*, r.return_code as latest_return_code, r.return_reason as latest_return_reason, r.processed_at as return_processed_at
       FROM ach_entries e
       LEFT JOIN LATERAL (
         SELECT return_code, return_reason, processed_at FROM ach_returns
         WHERE entry_id = e.id ORDER BY processed_at DESC LIMIT 1
       ) r ON true
       WHERE e.batch_id = $1
       ORDER BY e.entry_sequence`,
      [batchId]
    );
    return result.rows;
  }

  /**
   * Cancel a pending batch.
   */
  static async cancelBatch(batchId) {
    const result = await pool.query(
      `UPDATE ach_batches SET status = 'cancelled', updated_at = NOW()
       WHERE batch_id = $1 AND status = 'pending' RETURNING *`,
      [batchId]
    );
    if (!result.rows.length) throw new Error(`Batch not found or not in pending status: ${batchId}`);
    return result.rows[0];
  }

  /**
   * Get transmission history for a batch.
   */
  static async getTransmissions(batchId) {
    const result = await pool.query(
      'SELECT * FROM ach_transmissions WHERE batch_id = $1 ORDER BY transmitted_at DESC',
      [batchId]
    );
    return result.rows;
  }

  /**
   * Get AS2 pipeline status — config + connectivity.
   */
  static async getPipelineStatus() {
    const config = AS2Client.getConfigStatus();
    let connectivity = { connected: false, error: 'Not tested' };

    if (config.configured) {
      try {
        connectivity = await AS2Client.testConnection();
      } catch (e) {
        connectivity = { connected: false, error: e.message };
      }
    }

    const pendingBatches = await pool.query(
      "SELECT COUNT(*) as count FROM ach_batches WHERE status = 'pending'"
    );
    const transmittedToday = await pool.query(
      "SELECT COUNT(*) as count FROM ach_batches WHERE status = 'transmitted' AND transmitted_at::date = CURRENT_DATE"
    );
    const acceptedBatches = await pool.query(
      "SELECT COUNT(*) as count FROM ach_batches WHERE status = 'accepted'"
    );
    const settledBatches = await pool.query(
      "SELECT COUNT(*) as count FROM ach_batches WHERE status = 'settled'"
    );
    const returnedBatches = await pool.query(
      "SELECT COUNT(*) as count FROM ach_batches WHERE status = 'returned'"
    );
    const failedRecent = await pool.query(
      "SELECT COUNT(*) as count FROM ach_batches WHERE status = 'failed' AND created_at > NOW() - INTERVAL '7 days'"
    );

    return {
      as2_config: config,
      as2_connectivity: connectivity,
      pipeline: {
        pending_batches: parseInt(pendingBatches.rows[0].count, 10),
        transmitted_today: parseInt(transmittedToday.rows[0].count, 10),
        accepted_batches: parseInt(acceptedBatches.rows[0].count, 10),
        settled_batches: parseInt(settledBatches.rows[0].count, 10),
        returned_batches: parseInt(returnedBatches.rows[0].count, 10),
        failed_last_7_days: parseInt(failedRecent.rows[0].count, 10),
      },
    };
  }

  /**
   * Create a disbursement batch from CRM contacts with bank info.
   * Pulls contacts + their bank accounts, creates ACH entries.
   */
  static async createDisbursementBatch({ contactIds, amountCents, description, effectiveDate, createdBy }) {
    if (!contactIds || !contactIds.length) throw new Error('contactIds required');
    if (!amountCents || amountCents <= 0) throw new Error('amountCents must be positive');

    const placeholders = contactIds.map((_, i) => `$${i + 1}`).join(',');
    const contacts = await pool.query(
      `SELECT * FROM crm_contacts WHERE contact_id = ANY($1) AND status = 'active'`,
      [contactIds]
    );

    if (!contacts.rows.length) throw new Error('No active contacts found');

    const entries = [];
    for (const contact of contacts.rows) {
      if (!contact.routing_number || !contact.account_number) {
        continue; // skip contacts without bank info
      }
      entries.push({
        receivingRouting: contact.routing_number,
        accountNumber: contact.account_number,
        amountCents,
        transactionCode: contact.bank_account_type === 'savings' ? '32' : '22',
        individualId: contact.contact_id,
        individualName: `${contact.first_name} ${contact.last_name}`.substring(0, 22),
        memo: description || 'Trust Distribution',
      });
    }

    if (!entries.length) throw new Error('No contacts with bank account info found');

    return ACHEngine.createBatch({
      effectiveDate: effectiveDate || new Date().toISOString().split('T')[0],
      secCode: 'PPD',
      description: (description || 'TRUST DIST').substring(0, 10),
      createdBy,
    }, entries);
  }

  /**
   * Download NACHA file content for a batch.
   */
  static async downloadBatch(batchId) {
    const batch = await pool.query(
      'SELECT batch_id, filename, nacha_content FROM ach_batches WHERE batch_id = $1',
      [batchId]
    );
    if (!batch.rows.length) throw new Error(`Batch not found: ${batchId}`);
    return batch.rows[0];
  }

  /**
   * Validate a NACHA file content string.
   */
  static validateNACHA(content) {
    try {
      const parsed = parseNACHAFile(content);
      const errors = [];

      if (!parsed.fileHeader) errors.push('Missing file header record');
      if (!parsed.batches.length) errors.push('No batch records found');
      if (!parsed.fileControl) errors.push('Missing file control record');

      for (const batch of parsed.batches) {
        if (!batch.entries.length) {
          errors.push(`Batch "${batch.companyName}" has no entries`);
        }
        if (batch.control) {
          if (batch.control.entryCount !== batch.entries.length) {
            errors.push(`Batch entry count mismatch: control=${batch.control.entryCount}, actual=${batch.entries.length}`);
          }
        }
      }

      return {
        valid: errors.length === 0,
        errors,
        parsed,
      };
    } catch (e) {
      return { valid: false, errors: [e.message], parsed: null };
    }
  }
}

module.exports = { ACHEngine };
