'use strict';

/**
 * System-to-system clearing-file automation
 *
 * The trust's data workflows produce payment data; the bank's pipeline ingests
 * one file shape per rail. This engine is the automated join between them, and
 * it is the same code path however the data arrives:
 *
 *   • a data workflow calls `format` with the bytes it holds;
 *   • an operator or upstream system POSTs them to the clearing-spec routes;
 *   • a scheduled or scripted intake cycle picks them up out of the inbox
 *     directory a workflow drops files into.
 *
 * Each run does four things in order, and stops at the first one that fails:
 * detect the inbound format, lift it into canonical instructions, resolve the
 * bank clearing spec the instructions' rail requires, then validate and render.
 *
 * Three properties are load-bearing:
 *
 *   • Detection chooses the input parser, configuration chooses the output
 *     spec. Inbound bytes can never redirect a file at a different bank.
 *   • The money comes from the Trust Operating Account or from the trust
 *     account of one named beneficiary, and from nothing else. Which one is
 *     resolved against the trust's own ledgers before anything is rendered, so
 *     a column in an inbound file cannot draw a wire on bond proceeds, a
 *     reserve or an escrow: see `fundingSourceRegistry`.
 *   • Formatting and sending are separate. A formatted file is bytes, a digest,
 *     a manifest and an archive entry; it reaches a bank only when the caller
 *     asks for delivery *and* the Direct Send channel is itself ready, and it
 *     then travels over that channel's authenticated, signed transport.
 *   • A spec that is a portal upload rather than a bank pipeline file — the
 *     Melio bill import — is refused delivery outright. It is rendered and
 *     archived like any other spec and then imported by a person, so the file a
 *     data workflow produces and the payment a person approves stay distinct.
 *   • A spec decides how many files a batch becomes. Most specs batch every
 *     instruction into one file; the Fedwire Funds Service carries one credit
 *     transfer per ISO 20022 message, so a run there renders one message per
 *     payment, each with its own digest, manifest and delivery.
 *   • Every run leaves evidence. The payload, its manifest and its detached
 *     signature are archived under the batch id before anything is transmitted,
 *     because the file is the instruction of record.
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const { getClearingSpecConfig, clearingSpecReadiness } = require('./clearingSpecConfig');
const { formatToSpecFiles, listSpecs, specIds, ClearingSpecError } = require('./clearingSpecRegistry');
const { normalize, detectFormat, ClearingIntakeError } = require('./clearingIntakeDetector');
const { FundingSourceRegistry } = require('./fundingSourceRegistry');
const { signClearingFile } = require('../wire/wireClearingFile');
const { getDirectSendConfig, directSendReadiness } = require('../wire/wireDirectSendConfig');
const { sendClearingFile } = require('../wire/wireDirectSendTransport');

class ClearingAutoFormatError extends Error {
  constructor(message, code = 'CLEARING_AUTOFORMAT_ERROR', status = 400) {
    super(message);
    this.name = 'ClearingAutoFormatError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function newBatchId() {
  return `CLRFMT-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '');
}

function profileFrom(config, overrides = {}) {
  return {
    senderId: overrides.senderId || config.senderId,
    senderName: overrides.senderName || config.senderName,
    senderRouting: overrides.senderRouting || config.senderRouting,
    senderAccount: overrides.senderAccount || config.senderAccount,
    receiverId: overrides.receiverId || config.receiverId,
    receiverRouting: overrides.receiverRouting || config.receiverRouting,
    receiverName: overrides.receiverName || config.receiverName,
    entryDescription: overrides.entryDescription || null,
    currency: config.currency,
    fedwire: { ...config.fedwire, ...(overrides.fedwire || {}) },
  };
}

/**
 * Which rail these instructions travel on. The data may say (a CSV column, a
 * NACHA file's own geometry, a pain.001 service level); when it says nothing
 * the configured default applies. When it says two different things the file is
 * refused, because one clearing file clears one rail.
 */
function resolveRail(instructions, { requestedRail = null, config }) {
  if (requestedRail) {
    return { rail: String(requestedRail).toLowerCase(), source: 'caller' };
  }
  const declared = [...new Set(instructions.map(instruction => instruction.rail).filter(Boolean))];
  if (declared.length > 1) {
    throw new ClearingAutoFormatError(
      `The instruction set mixes rails (${declared.join(', ')}); one clearing file clears one rail`,
      'CLEARING_AUTOFORMAT_MIXED_RAIL',
      409
    );
  }
  if (declared.length === 1) return { rail: declared[0], source: 'source data' };
  return { rail: config.defaultRail, source: 'CLEARING_AUTOFORMAT_DEFAULT_RAIL' };
}

function resolveSpec({ rail, requestedSpec = null, config }) {
  if (requestedSpec) {
    const wanted = String(requestedSpec).toLowerCase();
    if (!specIds().includes(wanted)) {
      throw new ClearingSpecError(
        `Unknown bank clearing spec "${requestedSpec}"; known specs are ${specIds().join(', ')}`,
        'CLEARING_SPEC_UNKNOWN',
        400
      );
    }
    return { specId: wanted, source: 'caller' };
  }
  const mapped = config.railSpecs[rail];
  if (!mapped) {
    throw new ClearingAutoFormatError(
      `No bank clearing spec is configured for the ${rail} rail; map it in CLEARING_SPEC_RAIL_MAP`,
      'CLEARING_AUTOFORMAT_NO_SPEC',
      409
    );
  }
  return { specId: mapped, source: 'CLEARING_SPEC_RAIL_MAP' };
}

function enforceLimits(instructions, config) {
  if (instructions.length > config.maxItems) {
    throw new ClearingAutoFormatError(
      `${instructions.length} instructions exceed CLEARING_AUTOFORMAT_MAX_ITEMS (${config.maxItems})`,
      'CLEARING_AUTOFORMAT_TOO_MANY',
      409
    );
  }
  const total = instructions.reduce((sum, instruction) => sum + Number(instruction.amountCents || 0), 0);
  if (config.maxAmountCents && total > config.maxAmountCents) {
    throw new ClearingAutoFormatError(
      `The file totals ${(total / 100).toFixed(2)}, over the CLEARING_AUTOFORMAT_MAX_AMOUNT_CENTS ceiling of ${(config.maxAmountCents / 100).toFixed(2)}`,
      'CLEARING_AUTOFORMAT_OVER_CEILING',
      409
    );
  }
  return total;
}

function summarise(instructions) {
  const currencies = [...new Set(instructions.map(instruction => (instruction.currency || 'USD').toUpperCase()))];
  return {
    count: instructions.length,
    totalAmountCents: instructions.reduce((sum, instruction) => sum + Number(instruction.amountCents || 0), 0),
    currencies,
    rails: [...new Set(instructions.map(instruction => instruction.rail).filter(Boolean))],
    creditors: instructions.slice(0, 10).map(instruction => (instruction.creditor && instruction.creditor.name) || null),
  };
}

function buildManifest({ batchId, filename, formatted, instructions, detection, rail, signature, profile, source, funding }) {
  return {
    batchId,
    filename,
    spec: formatted.specId,
    specFormat: formatted.format,
    rail,
    createdAt: formatted.createdAt,
    source: source || null,
    // What the file is drawn on, kept with the file because the manifest is the
    // audit record of a payment's funding as well as of its bytes.
    funding: funding || null,
    detectedFormat: detection.format,
    detectionConfidence: detection.confidence,
    sender: profile.senderId,
    receiver: profile.receiverId || null,
    currency: formatted.currency,
    controls: {
      ...formatted.controls,
      totalAmount: (Number(formatted.controls.totalAmountCents || 0) / 100).toFixed(2),
      payloadSha256: formatted.payloadHash,
    },
    signature: signature ? { algorithm: signature.algorithm, value: signature.value } : null,
    items: instructions.map((instruction, index) => ({
      reference: instruction.reference || instruction.endToEndId || `${batchId}-${index + 1}`,
      amountCents: Number(instruction.amountCents || 0),
      currency: (instruction.currency || formatted.currency).toUpperCase(),
      creditorName: (instruction.creditor && instruction.creditor.name) || null,
      creditorRouting: (instruction.creditor && (instruction.creditor.routingNumber || instruction.creditor.bic)) || null,
      direction: instruction.direction || 'credit',
      fundingSource: instruction.fundingSource ? instruction.fundingSource.sourceKey : null,
      fundingAccountName: instruction.fundingSource ? instruction.fundingSource.accountName : null,
    })),
  };
}

/**
 * A per-transaction spec turns one instruction set into several messages, so
 * each file carries the sequence in its name; a batched spec keeps the plain
 * one-file-per-batch name.
 */
function filenameFor({ config, rail, createdAt, batchId, formatted }) {
  const suffix = formatted.of > 1 ? `-${String(formatted.sequence).padStart(3, '0')}` : '';
  return `${config.filePrefix}-${rail.toUpperCase()}-${stamp(createdAt)}-${batchId.split('-').pop()}${suffix}${formatted.extension}`;
}

async function archive({ config, batchId, filename, formatted, manifest, signature }) {
  const dir = path.join(config.archiveDir, batchId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, filename), formatted.payload, 'utf8');
  if (config.writeManifest && manifest) {
    await fsp.writeFile(path.join(dir, `${filename}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  if (signature) {
    await fsp.writeFile(path.join(dir, `${filename}.sig`), `${signature.algorithm} ${signature.value}\n`, 'utf8');
  }
  return dir;
}

const ClearingAutoFormatEngine = {
  ClearingAutoFormatError,

  specs() {
    return listSpecs();
  },

  readiness() {
    return clearingSpecReadiness(specIds());
  },

  status() {
    const config = getClearingSpecConfig();
    return {
      ...clearingSpecReadiness(specIds()),
      specs: listSpecs(),
      archiveDir: config.archiveDir,
      delivery: directSendReadiness(),
    };
  },

  /**
   * The accounts this workflow may draw on — the Trust Operating Account and
   * each beneficiary's trust account — with the position the owning ledger
   * reports for each.
   */
  async fundingSources() {
    return {
      ...(await FundingSourceRegistry.readiness()),
      sources: await FundingSourceRegistry.list(),
    };
  },

  /**
   * `inspect` plus the funding decision: which account each instruction is
   * drawn on and whether the money is there. Nothing is refused here — what
   * `format` would refuse comes back as `funding.failures`, so a data workflow
   * can check an export before it clears anything.
   */
  async plan({ input, format = null, rail = null, spec = null, fundingSource = null } = {}) {
    const inspected = this.inspect({ input, format, rail, spec });
    const { instructions } = normalize(input, { format: inspected.detection.format });
    const funding = await FundingSourceRegistry.plan(instructions, { fundingSource });
    return {
      ...inspected,
      funding: {
        sources: funding.sources,
        failures: funding.failures,
        fundable: funding.failures.length === 0,
        enforced: funding.enforced,
        balanceEnforced: funding.balanceEnforced,
      },
    };
  },

  /**
   * Dry run: what arrived, what it says, and what the bank would be sent —
   * without rendering a file or touching the filesystem.
   */
  inspect({ input, format = null, rail = null, spec = null }) {
    const config = getClearingSpecConfig();
    const detection = format
      ? { format: String(format).toLowerCase(), confidence: 'declared', evidence: 'the caller declared the format' }
      : detectFormat(input);
    const { instructions } = normalize(input, { format: detection.format });
    const railResolution = resolveRail(instructions, { requestedRail: rail, config });
    const specResolution = resolveSpec({ rail: railResolution.rail, requestedSpec: spec, config });
    const perTransaction = Boolean((listSpecs().find(entry => entry.id === specResolution.specId) || {}).perTransaction);
    return {
      detection,
      rail: railResolution.rail,
      railSource: railResolution.source,
      spec: specResolution.specId,
      specSource: specResolution.source,
      files: perTransaction ? instructions.length : 1,
      portalUpload: Boolean((listSpecs().find(entry => entry.id === specResolution.specId) || {}).portalUpload),
      summary: summarise(instructions),
    };
  },

  /**
   * Detect, normalise, resolve the spec and render the clearing file. With
   * `deliver` the bytes then go out over the Direct Send channel; without it
   * they are archived and returned, which is what a data workflow that stages
   * files for review wants.
   */
  async format({
    input,
    format = null,
    rail = null,
    spec = null,
    source = null,
    actor = null,
    deliver = false,
    fundingSource = null,
    profile: profileOverrides = {},
    batchId = null,
    createdAt = new Date(),
  } = {}) {
    const config = getClearingSpecConfig();
    if (!config.enabled) {
      throw new ClearingAutoFormatError(
        'CLEARING_AUTOFORMAT_ENABLED is off: automatic clearing-file formatting is closed',
        'CLEARING_AUTOFORMAT_DISABLED',
        409
      );
    }
    const size = Buffer.isBuffer(input) ? input.length : (typeof input === 'string' ? Buffer.byteLength(input) : 0);
    if (size > config.maxInputBytes) {
      throw new ClearingAutoFormatError(
        `The payload is ${size} bytes, over the CLEARING_AUTOFORMAT_MAX_INPUT_BYTES ceiling of ${config.maxInputBytes}`,
        'CLEARING_AUTOFORMAT_TOO_LARGE',
        413
      );
    }

    const { detection, instructions: parsed } = normalize(input, { format });
    const railResolution = resolveRail(parsed, { requestedRail: rail, config });
    const specResolution = resolveSpec({ rail: railResolution.rail, requestedSpec: spec, config });
    enforceLimits(parsed, config);

    // Where the money comes from, decided before a single byte is rendered: the
    // resolved account becomes each instruction's debtor, so the file the bank
    // ingests names the account the trust actually draws on rather than a
    // generic sender.
    const funding = await FundingSourceRegistry.apply(parsed, { fundingSource });
    const instructions = funding.instructions;
    const fundingSummary = {
      sources: funding.sources,
      failures: funding.failures,
      enforced: funding.enforced,
      balanceEnforced: funding.balanceEnforced,
    };

    const id = batchId || newBatchId();
    const profile = profileFrom(config, profileOverrides);
    // One file for a batched spec, one message per payment for a spec the rail
    // carries one transaction at a time — the Fedwire Funds Service.
    const rendered = formatToSpecFiles({
      specId: specResolution.specId,
      instructions,
      batchId: id,
      profile,
      createdAt,
    });

    const portalUpload = Boolean((listSpecs().find(entry => entry.id === specResolution.specId) || {}).portalUpload);
    if (deliver && portalUpload) {
      throw new ClearingAutoFormatError(
        `${specResolution.specId} is a portal upload, not a bank pipeline file: it is imported in the provider's portal, so it cannot be delivered over the clearing channel`,
        'CLEARING_AUTOFORMAT_PORTAL_UPLOAD',
        409
      );
    }

    const directSend = getDirectSendConfig();
    const channel = deliver ? directSendReadiness() : null;
    if (deliver && !channel.ready) {
      throw new ClearingAutoFormatError(
        `The clearing channel is closed, so batch ${id} was not sent: ${channel.blockers.join('; ')}`,
        'CLEARING_AUTOFORMAT_CHANNEL_CLOSED',
        409
      );
    }

    const files = [];
    for (const formatted of rendered) {
      const filename = filenameFor({ config, rail: railResolution.rail, createdAt, batchId: id, formatted });
      const signature = signClearingFile(formatted.payload, directSend);
      const manifest = buildManifest({
        batchId: formatted.of > 1 ? `${id}-${String(formatted.sequence).padStart(3, '0')}` : id,
        filename,
        formatted,
        instructions: formatted.instructions,
        detection,
        rail: railResolution.rail,
        signature,
        profile,
        source,
        funding: fundingSummary,
      });
      const archivePath = await archive({ config, batchId: id, filename, formatted, manifest, signature });
      files.push({
        filename,
        sequence: formatted.sequence,
        of: formatted.of,
        contentType: formatted.contentType,
        payloadHash: formatted.payloadHash,
        controls: manifest.controls,
        manifest,
        archivePath,
        signed: Boolean(signature),
        signature,
        delivered: false,
        delivery: null,
        payload: formatted.payload,
      });
    }

    const result = {
      batchId: id,
      spec: specResolution.specId,
      specSource: specResolution.source,
      rail: railResolution.rail,
      railSource: railResolution.source,
      detection,
      funding: fundingSummary,
      currency: rendered[0].currency,
      controls: {
        files: files.length,
        count: instructions.length,
        totalAmountCents: instructions.reduce((sum, instruction) => sum + Number(instruction.amountCents || 0), 0),
      },
      files: files.map(({ signature, ...file }) => file),
      archivePath: path.join(config.archiveDir, id),
      actor: actor || null,
      source: source || null,
      delivered: false,
    };

    if (!deliver) return result;

    for (const file of files) {
      if (directSend.requireSignature && !file.signed) {
        throw new ClearingAutoFormatError(
          `${file.filename} is unsigned and WIRE_DIRECT_SEND_REQUIRE_SIGNATURE is on`,
          'CLEARING_AUTOFORMAT_UNSIGNED',
          409
        );
      }
      try {
        const receipt = await sendClearingFile({
          file: {
            batchId: file.manifest.batchId,
            filename: file.filename,
            payload: file.payload,
            payloadHash: file.payloadHash,
            count: Number(file.controls.count || 0),
            totalAmountCents: Number(file.controls.totalAmountCents || 0),
            currency: rendered[0].currency,
          },
          manifest: file.manifest,
          signature: file.signature,
          // The file's own spec decides the content type; everything else about
          // the channel — endpoint, certificates, drop directory — stays as
          // configured.
          config: { ...directSend, contentType: file.contentType },
        });
        file.delivered = true;
        file.delivery = receipt;
      } catch (error) {
        // A batch the bank holds part of must not be retried wholesale, so a
        // failure after anything has gone out is reported as ambiguous even
        // when the transport itself was certain.
        if (files.some(entry => entry.delivered)) {
          error.ambiguous = true;
          error.message = `${error.message} (${files.filter(entry => entry.delivered).length} of ${files.length} messages in batch ${id} were already sent)`;
        }
        throw error;
      }
    }

    return {
      ...result,
      delivered: true,
      files: files.map(({ signature, ...file }) => file),
    };
  },

  /**
   * One intake cycle: every recognised file in the inbox is formatted and moved
   * out of the way, so a repeated cycle never re-sends a file. A file that
   * cannot be formatted is moved to `failed` with its error beside it, because
   * a workflow that keeps re-dropping a broken file must not block the good
   * ones behind it.
   */
  async runIntakeCycle({ actor = null, deliver = null, limit = null, trigger = 'operator' } = {}) {
    const config = getClearingSpecConfig();
    const shouldDeliver = deliver === null || deliver === undefined ? config.deliverOnIntake : Boolean(deliver);
    for (const dir of [config.inboxDir, config.outboxDir, config.processedDir, config.failedDir]) {
      await fsp.mkdir(dir, { recursive: true });
    }

    const names = (await fsp.readdir(config.inboxDir))
      .filter(name => !name.startsWith('.'))
      .filter(name => config.intakeExtensions.includes(path.extname(name).toLowerCase()))
      .sort()
      .slice(0, Math.min(limit ? Number(limit) : config.intakeMaxFiles, config.intakeMaxFiles));

    const formatted = [];
    const failed = [];
    for (const name of names) {
      const inputPath = path.join(config.inboxDir, name);
      const stats = await fsp.stat(inputPath);
      if (!stats.isFile()) continue;
      try {
        const raw = await fsp.readFile(inputPath, 'utf8');
        const result = await this.format({
          input: raw,
          source: `intake:${name}`,
          actor,
          deliver: shouldDeliver,
        });
        for (const file of result.files) {
          await fsp.writeFile(path.join(config.outboxDir, file.filename), file.payload, 'utf8');
          if (config.writeManifest) {
            await fsp.writeFile(
              path.join(config.outboxDir, `${file.filename}.manifest.json`),
              `${JSON.stringify(file.manifest, null, 2)}\n`,
              'utf8'
            );
          }
        }
        await fsp.rename(inputPath, path.join(config.processedDir, `${result.batchId}-${name}`));
        formatted.push({
          input: name,
          batchId: result.batchId,
          filenames: result.files.map(file => file.filename),
          spec: result.spec,
          rail: result.rail,
          detectedFormat: result.detection.format,
          count: result.controls.count,
          totalAmountCents: result.controls.totalAmountCents,
          delivered: result.delivered,
          delivery: result.files
            .filter(file => file.delivery)
            .map(file => ({ filename: file.filename, status: file.delivery.status, reference: file.delivery.reference })),
        });
      } catch (error) {
        const reason = {
          input: name,
          code: error.code || 'CLEARING_AUTOFORMAT_ERROR',
          error: error.message,
          failures: error.failures || null,
          ambiguous: Boolean(error.ambiguous),
        };
        failed.push(reason);
        // An ambiguous delivery outcome means the bank may already hold the
        // bytes, so the input is kept where an operator has to look at it.
        if (!error.ambiguous) {
          await fsp.rename(inputPath, path.join(config.failedDir, name)).catch(() => {});
          await fsp.writeFile(
            path.join(config.failedDir, `${name}.error.json`),
            `${JSON.stringify(reason, null, 2)}\n`,
            'utf8'
          ).catch(() => {});
        }
      }
    }

    return {
      trigger,
      actor: actor || null,
      inbox: config.inboxDir,
      outbox: config.outboxDir,
      scanned: names.length,
      delivered: shouldDeliver,
      formatted,
      failed,
    };
  },

  /**
   * The unattended loop, for a workflow that writes into the inbox on its own
   * schedule. Off unless `CLEARING_AUTOFORMAT_AUTO_INTAKE` is set, and the
   * cycles it runs are the same ones the CLI and the route run.
   */
  startAutoIntake() {
    const config = getClearingSpecConfig();
    if (this._timer) return { started: false, reason: 'already running' };
    if (!config.autoIntake) return { started: false, reason: 'CLEARING_AUTOFORMAT_AUTO_INTAKE is off' };
    if (!config.enabled) return { started: false, reason: 'CLEARING_AUTOFORMAT_ENABLED is off' };

    const tick = async () => {
      if (this._running) return;
      this._running = true;
      try {
        const report = await this.runIntakeCycle({ trigger: 'scheduler', actor: 'clearing-intake-scheduler' });
        this._lastReport = report;
        if (report.formatted.length || report.failed.length) {
          console.log(`[clearing-intake] formatted ${report.formatted.length}, failed ${report.failed.length}`);
        }
      } catch (err) {
        console.warn('[clearing-intake] cycle failed:', err.message);
      } finally {
        this._running = false;
      }
    };

    this._timer = setInterval(tick, config.autoIntervalSeconds * 1000);
    if (this._timer.unref) this._timer.unref();
    console.log(`[clearing-intake] watching ${config.inboxDir} every ${config.autoIntervalSeconds}s`);
    return { started: true, intervalSeconds: config.autoIntervalSeconds, inbox: config.inboxDir };
  },

  stopAutoIntake() {
    if (!this._timer) return { stopped: false };
    clearInterval(this._timer);
    this._timer = null;
    return { stopped: true };
  },

  _timer: null,
  _running: false,
  _lastReport: null,
};

module.exports = {
  ClearingAutoFormatEngine,
  ClearingAutoFormatError,
  ClearingIntakeError,
  ClearingSpecError,
  resolveRail,
  resolveSpec,
};
