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
 *   • Formatting and sending are separate. A formatted file is bytes, a digest,
 *     a manifest and an archive entry; it reaches a bank only when the caller
 *     asks for delivery *and* the Direct Send channel is itself ready, and it
 *     then travels over that channel's authenticated, signed transport.
 *   • Every run leaves evidence. The payload, its manifest and its detached
 *     signature are archived under the batch id before anything is transmitted,
 *     because the file is the instruction of record.
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const { getClearingSpecConfig, clearingSpecReadiness } = require('./clearingSpecConfig');
const { formatToSpec, listSpecs, specIds, ClearingSpecError } = require('./clearingSpecRegistry');
const { normalize, detectFormat, ClearingIntakeError } = require('./clearingIntakeDetector');
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

function buildManifest({ batchId, filename, formatted, instructions, detection, rail, signature, profile, source }) {
  return {
    batchId,
    filename,
    spec: formatted.specId,
    specFormat: formatted.format,
    rail,
    createdAt: formatted.createdAt,
    source: source || null,
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
    })),
  };
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
    return {
      detection,
      rail: railResolution.rail,
      railSource: railResolution.source,
      spec: specResolution.specId,
      specSource: specResolution.source,
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

    const { detection, instructions } = normalize(input, { format });
    const railResolution = resolveRail(instructions, { requestedRail: rail, config });
    const specResolution = resolveSpec({ rail: railResolution.rail, requestedSpec: spec, config });
    enforceLimits(instructions, config);

    const id = batchId || newBatchId();
    const profile = profileFrom(config, profileOverrides);
    const formatted = formatToSpec({
      specId: specResolution.specId,
      instructions,
      batchId: id,
      profile,
      createdAt,
    });

    const filename = `${config.filePrefix}-${railResolution.rail.toUpperCase()}-${stamp(createdAt)}-${id.split('-').pop()}${formatted.extension}`;
    const directSend = getDirectSendConfig();
    const signature = signClearingFile(formatted.payload, directSend);
    const manifest = buildManifest({
      batchId: id,
      filename,
      formatted,
      instructions,
      detection,
      rail: railResolution.rail,
      signature,
      profile,
      source,
    });
    const archivePath = await archive({ config, batchId: id, filename, formatted, manifest, signature });

    const result = {
      batchId: id,
      filename,
      spec: formatted.specId,
      specSource: specResolution.source,
      rail: railResolution.rail,
      railSource: railResolution.source,
      detection,
      contentType: formatted.contentType,
      currency: formatted.currency,
      controls: manifest.controls,
      manifest,
      archivePath,
      signed: Boolean(signature),
      actor: actor || null,
      source: source || null,
      delivered: false,
      delivery: null,
      payload: formatted.payload,
    };

    if (!deliver) return result;

    const channel = directSendReadiness();
    if (!channel.ready) {
      throw new ClearingAutoFormatError(
        `The clearing channel is closed, so ${filename} was formatted and archived but not sent: ${channel.blockers.join('; ')}`,
        'CLEARING_AUTOFORMAT_CHANNEL_CLOSED',
        409
      );
    }
    if (directSend.requireSignature && !signature) {
      throw new ClearingAutoFormatError(
        `${filename} is unsigned and WIRE_DIRECT_SEND_REQUIRE_SIGNATURE is on`,
        'CLEARING_AUTOFORMAT_UNSIGNED',
        409
      );
    }

    const receipt = await sendClearingFile({
      file: {
        batchId: id,
        filename,
        payload: formatted.payload,
        payloadHash: formatted.payloadHash,
        count: Number(formatted.controls.count || 0),
        totalAmountCents: Number(formatted.controls.totalAmountCents || 0),
        currency: formatted.currency,
      },
      manifest,
      signature,
      // The file's own spec decides the content type; everything else about the
      // channel — endpoint, certificates, drop directory — stays as configured.
      config: { ...directSend, contentType: formatted.contentType },
    });

    return { ...result, delivered: true, delivery: receipt };
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
        await fsp.writeFile(path.join(config.outboxDir, result.filename), result.payload, 'utf8');
        if (config.writeManifest) {
          await fsp.writeFile(
            path.join(config.outboxDir, `${result.filename}.manifest.json`),
            `${JSON.stringify(result.manifest, null, 2)}\n`,
            'utf8'
          );
        }
        await fsp.rename(inputPath, path.join(config.processedDir, `${result.batchId}-${name}`));
        formatted.push({
          input: name,
          batchId: result.batchId,
          filename: result.filename,
          spec: result.spec,
          rail: result.rail,
          detectedFormat: result.detection.format,
          count: result.controls.count,
          totalAmountCents: result.controls.totalAmountCents,
          delivered: result.delivered,
          delivery: result.delivery ? { status: result.delivery.status, reference: result.delivery.reference } : null,
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
