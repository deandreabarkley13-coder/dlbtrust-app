'use strict';

/**
 * ISO 20022 message layer
 *
 * The in-house bank speaks the same language as the banks around it:
 *
 *   pain.001  customer credit transfer initiation — how an instruction arrives
 *   pain.002  payment status report — how the bank answers
 *   pacs.008  FI-to-FI credit transfer — what is sent to the rail
 *   camt.053  bank-to-customer statement — the daily statement of a virtual
 *             account, which is what makes a virtual account usable in a
 *             counterparty's or auditor's own accounting system
 *
 * The reader is deliberately narrow. It extracts the fields the payment
 * pipeline needs and refuses the message when one is missing, instead of
 * defaulting it — a pain.001 with no amount is not a zero-value payment, it is
 * a broken file. Multi-transaction batches are expanded into one canonical
 * instruction per CdtTrfTxInf so that governance, routing and the ledger all
 * see individual payments rather than a batch total.
 */

const crypto = require('crypto');
const { getConfig } = require('./inHouseBankConfig');

class Iso20022Error extends Error {
  constructor(message, code = 'IHB_ISO_INVALID', status = 400) {
    super(message);
    this.name = 'Iso20022Error';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function escapeXml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Strip namespace prefixes so `<ns:Amt>` and `<Amt>` read the same. */
function tagBody(xml, tag) {
  const match = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'i').exec(xml);
  return match ? match[1] : null;
}

function tagText(xml, tag) {
  const body = tagBody(xml, tag);
  if (body === null) return null;
  const text = body.replace(/<[^>]*>/g, '').trim();
  return text ? unescapeXml(text) : null;
}

function tagAttribute(xml, tag, attribute) {
  const match = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b([^>]*)>`, 'i').exec(xml);
  if (!match) return null;
  const attr = new RegExp(`${attribute}\\s*=\\s*"([^"]*)"`, 'i').exec(match[1]);
  return attr ? attr[1] : null;
}

function allBlocks(xml, tag) {
  const blocks = [];
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'gi');
  let match = pattern.exec(xml);
  while (match) {
    blocks.push(match[1]);
    match = pattern.exec(xml);
  }
  return blocks;
}

function amountToCents(raw, field) {
  const value = String(raw || '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Iso20022Error(`${field} is not a valid amount: ${raw}`, 'IHB_ISO_BAD_AMOUNT');
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

function timestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const Iso20022 = {
  /**
   * pain.001 → one canonical instruction per credit transfer transaction.
   * @returns {{messageId: string, instructions: object[]}}
   */
  parsePain001(xml) {
    if (!xml || typeof xml !== 'string' || !/CstmrCdtTrfInitn/i.test(xml)) {
      throw new Iso20022Error('Payload is not a pain.001 CustomerCreditTransferInitiation message');
    }
    const header = tagBody(xml, 'GrpHdr') || '';
    const messageId = tagText(header, 'MsgId');
    if (!messageId) throw new Iso20022Error('GrpHdr/MsgId is missing', 'IHB_ISO_NO_MSGID');

    const instructions = [];
    for (const payment of allBlocks(xml, 'PmtInf')) {
      const debtorAccount =
        tagText(tagBody(payment, 'DbtrAcct') || '', 'Id') ||
        tagText(tagBody(payment, 'DbtrAcct') || '', 'Othr');
      const requestedExecutionDate = tagText(payment, 'ReqdExctnDt');
      const serviceLevel = tagText(tagBody(payment, 'PmtTpInf') || '', 'Cd');

      for (const transaction of allBlocks(payment, 'CdtTrfTxInf')) {
        const amountBlock = tagBody(transaction, 'Amt') || '';
        const amountRaw = tagText(amountBlock, 'InstdAmt');
        if (amountRaw === null) throw new Iso20022Error('CdtTrfTxInf/Amt/InstdAmt is missing', 'IHB_ISO_NO_AMOUNT');
        const currency = tagAttribute(amountBlock, 'InstdAmt', 'Ccy') || getConfig().currency;

        const creditorBlock = tagBody(transaction, 'Cdtr') || '';
        const creditorAccountBlock = tagBody(transaction, 'CdtrAcct') || '';
        const creditorAgentBlock = tagBody(transaction, 'CdtrAgt') || '';
        const creditorName = tagText(creditorBlock, 'Nm');
        if (!creditorName) throw new Iso20022Error('CdtTrfTxInf/Cdtr/Nm is missing', 'IHB_ISO_NO_CREDITOR');

        instructions.push({
          amountCents: amountToCents(amountRaw, 'InstdAmt'),
          currency: currency.toUpperCase(),
          debtorAccount,
          creditor: {
            name: creditorName,
            accountNumber: tagText(creditorAccountBlock, 'Othr') || tagText(creditorAccountBlock, 'IBAN') || tagText(creditorAccountBlock, 'Id'),
            iban: tagText(creditorAccountBlock, 'IBAN'),
            routingNumber: tagText(creditorAgentBlock, 'MmbId') || tagText(creditorAgentBlock, 'ClrSysMmbId'),
            bic: tagText(creditorAgentBlock, 'BICFI') || tagText(creditorAgentBlock, 'BIC'),
            country: (tagText(tagBody(creditorBlock, 'PstlAdr') || '', 'Ctry') || 'US').toUpperCase(),
          },
          endToEndId: tagText(tagBody(transaction, 'PmtId') || '', 'EndToEndId'),
          purposeCode: tagText(tagBody(transaction, 'Purp') || '', 'Cd') || 'OTHR',
          remittanceInformation: tagText(tagBody(transaction, 'RmtInf') || '', 'Ustrd'),
          requestedExecutionDate,
          // SEPA-style service levels map onto how fast the payer wants funds
          // to arrive; the routing engine decides which rail delivers it.
          requestedSpeed: serviceLevel && /SDVA|URGP|INST/i.test(serviceLevel) ? 'instant' : 'standard',
          sourceFormat: 'pain.001.001.09',
        });
      }
    }
    if (!instructions.length) throw new Iso20022Error('No CdtTrfTxInf transactions found in the message', 'IHB_ISO_EMPTY');
    return { messageId, instructions };
  },

  /** pain.002 status report — the bank's answer to a pain.001 or an API submission. */
  buildPain002({ originalMessageId, payments = [] }) {
    const config = getConfig();
    const messageId = `PAIN002-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const statuses = payments.map(payment => `
      <OrgnlPmtInfAndSts>
        <OrgnlPmtInfId>${escapeXml(payment.paymentId)}</OrgnlPmtInfId>
        <TxInfAndSts>
          <StsId>${escapeXml(payment.paymentId)}</StsId>
          <OrgnlEndToEndId>${escapeXml(payment.endToEndId || '')}</OrgnlEndToEndId>
          <TxSts>${escapeXml(Iso20022.statusCode(payment.status))}</TxSts>
          ${payment.reason ? `<StsRsnInf><Rsn><Prtry>${escapeXml(payment.reason)}</Prtry></Rsn></StsRsnInf>` : ''}
        </TxInfAndSts>
      </OrgnlPmtInfAndSts>`).join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.10">
  <CstmrPmtStsRpt>
    <GrpHdr>
      <MsgId>${escapeXml(messageId)}</MsgId>
      <CreDtTm>${timestamp()}</CreDtTm>
      <InitgPty><Nm>${escapeXml(config.bankName)}</Nm></InitgPty>
    </GrpHdr>
    <OrgnlGrpInfAndSts>
      <OrgnlMsgId>${escapeXml(originalMessageId || '')}</OrgnlMsgId>
      <OrgnlMsgNmId>pain.001.001.09</OrgnlMsgNmId>
    </OrgnlGrpInfAndSts>${statuses}
  </CstmrPmtStsRpt>
</Document>`;
  },

  /** Internal payment status → the ISO transaction status code a bank expects. */
  statusCode(status) {
    const map = {
      received: 'RCVD',
      screening: 'PDNG',
      pending_approval: 'PDNG',
      approved: 'ACTC',
      routed: 'ACTC',
      dispatched: 'ACSP',
      settled: 'ACSC',
      returned: 'RJCT',
      rejected: 'RJCT',
      failed: 'RJCT',
      cancelled: 'CANC',
    };
    return map[status] || 'PDNG';
  },

  /** pacs.008 — what actually goes out to the rail for an external payment. */
  buildPacs008(payment) {
    const config = getConfig();
    const amount = (Number(payment.amountCents) / 100).toFixed(2);
    const messageId = `PACS008-${payment.paymentId}`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>${escapeXml(messageId)}</MsgId>
      <CreDtTm>${timestamp()}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <TtlIntrBkSttlmAmt Ccy="${escapeXml(payment.currency || config.currency)}">${amount}</TtlIntrBkSttlmAmt>
      <SttlmInf><SttlmMtd>CLRG</SttlmMtd></SttlmInf>
      <InstgAgt><FinInstnId><BICFI>${escapeXml(config.bankBic)}</BICFI></FinInstnId></InstgAgt>
    </GrpHdr>
    <CdtTrfTxInf>
      <PmtId>
        <InstrId>${escapeXml(payment.paymentId)}</InstrId>
        <EndToEndId>${escapeXml(payment.endToEndId || payment.paymentId)}</EndToEndId>
        <UETR>${escapeXml(payment.uetr || '')}</UETR>
      </PmtId>
      <IntrBkSttlmAmt Ccy="${escapeXml(payment.currency || config.currency)}">${amount}</IntrBkSttlmAmt>
      <ChrgBr>SLEV</ChrgBr>
      <Dbtr><Nm>${escapeXml(config.bankName)}</Nm></Dbtr>
      <DbtrAcct><Id><Othr><Id>${escapeXml(payment.debtorAccountNumber || '')}</Id></Othr></Id></DbtrAcct>
      <DbtrAgt><FinInstnId><BICFI>${escapeXml(config.bankBic)}</BICFI></FinInstnId></DbtrAgt>
      <CdtrAgt><FinInstnId>${payment.creditor && payment.creditor.bic
        ? `<BICFI>${escapeXml(payment.creditor.bic)}</BICFI>`
        : `<ClrSysMmbId><MmbId>${escapeXml((payment.creditor && payment.creditor.routingNumber) || '')}</MmbId></ClrSysMmbId>`}</FinInstnId></CdtrAgt>
      <Cdtr><Nm>${escapeXml((payment.creditor && payment.creditor.name) || '')}</Nm></Cdtr>
      <CdtrAcct><Id><Othr><Id>${escapeXml((payment.creditor && (payment.creditor.accountNumber || payment.creditor.walletAddress)) || '')}</Id></Othr></Id></CdtrAcct>
      <Purp><Cd>${escapeXml(payment.purposeCode || 'OTHR')}</Cd></Purp>
      ${payment.remittanceInformation ? `<RmtInf><Ustrd>${escapeXml(payment.remittanceInformation)}</Ustrd></RmtInf>` : ''}
    </CdtTrfTxInf>
  </FIToFICstmrCdtTrf>
</Document>`;
  },

  /**
   * camt.053 statement for one virtual account. Opening and closing balances
   * are derived from the postings in the window, so the statement reconciles
   * by construction rather than by assertion.
   */
  buildCamt053({ account, postings = [], fromDate, toDate }) {
    const config = getConfig();
    const closingCents = Number(account.balanceCents || 0);
    const movement = postings.reduce(
      (total, posting) => total + (posting.direction === 'credit' ? Number(posting.amount_cents) : -Number(posting.amount_cents)),
      0
    );
    const openingCents = closingCents - movement;
    const money = value => (Number(value) / 100).toFixed(2);
    const entries = postings.map(posting => `
      <Ntry>
        <NtryRef>${escapeXml(posting.posting_id)}</NtryRef>
        <Amt Ccy="${escapeXml(config.currency)}">${money(posting.amount_cents)}</Amt>
        <CdtDbtInd>${posting.direction === 'credit' ? 'CRDT' : 'DBIT'}</CdtDbtInd>
        <Sts><Cd>BOOK</Cd></Sts>
        <BookgDt><DtTm>${escapeXml(new Date(posting.created_at).toISOString())}</DtTm></BookgDt>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>${escapeXml(posting.payment_id || '')}</EndToEndId></Refs>
          ${posting.memo ? `<RmtInf><Ustrd>${escapeXml(posting.memo)}</Ustrd></RmtInf>` : ''}
        </TxDtls></NtryDtls>
      </Ntry>`).join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr>
      <MsgId>CAMT053-${escapeXml(account.accountNumber)}-${Date.now()}</MsgId>
      <CreDtTm>${timestamp()}</CreDtTm>
    </GrpHdr>
    <Stmt>
      <Id>${escapeXml(account.accountNumber)}</Id>
      <CreDtTm>${timestamp()}</CreDtTm>
      <FrToDt><FrDtTm>${escapeXml(fromDate)}</FrDtTm><ToDtTm>${escapeXml(toDate)}</ToDtTm></FrToDt>
      <Acct>
        <Id><Othr><Id>${escapeXml(account.accountNumber)}</Id><SchmeNm><Prtry>VIRTUAL</Prtry></SchmeNm></Othr></Id>
        <Ccy>${escapeXml(config.currency)}</Ccy>
        <Nm>${escapeXml(account.name)}</Nm>
        <Svcr><FinInstnId><BICFI>${escapeXml(config.bankBic)}</BICFI><Nm>${escapeXml(config.bankName)}</Nm></FinInstnId></Svcr>
      </Acct>
      <Bal>
        <Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="${escapeXml(config.currency)}">${money(Math.abs(openingCents))}</Amt>
        <CdtDbtInd>${openingCents < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd>
      </Bal>
      <Bal>
        <Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="${escapeXml(config.currency)}">${money(Math.abs(closingCents))}</Amt>
        <CdtDbtInd>${closingCents < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd>
      </Bal>${entries}
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
  },
};

module.exports = { Iso20022, Iso20022Error };
