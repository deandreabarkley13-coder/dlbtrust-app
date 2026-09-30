'use strict';

/**
 * Re-anchor a hash-chained event table in place: recompute every event's
 * prev_hash / event_hash in sequence order with the engine's current hashing,
 * rewrite only the rows that differ, then append a `chain_resealed` event that
 * keeps each rewritten row's previous hashes so the repair itself is auditable.
 */
async function resealEventChain({ db, table, subjectColumn, subjectKey, hashEvent, appendEvent, actor, reason }) {
  const why = String(reason || '').trim();
  if (!why) throw Object.assign(new Error('reason is required to reseal the event chain'), { code: 'CHAIN_RESEAL_REASON', status: 400 });
  const client = await db.connect();
  const rewritten = [];
  let events = 0;
  let previousTipHash = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM ${table} ORDER BY sequence ASC FOR UPDATE`);
    events = rows.length;
    previousTipHash = rows.length ? rows[rows.length - 1].event_hash : null;
    let prevHash = null;
    for (const row of rows) {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
      const eventHash = hashEvent({
        prevHash, eventType: row.event_type, [subjectKey]: row[subjectColumn], actor: row.actor, payload,
        createdAt: new Date(row.created_at).toISOString(),
      });
      if ((row.prev_hash || null) !== prevHash || row.event_hash !== eventHash) {
        await client.query(`UPDATE ${table} SET prev_hash = $2, event_hash = $3 WHERE sequence = $1`, [row.sequence, prevHash, eventHash]);
        rewritten.push({ eventId: row.event_id, sequence: Number(row.sequence), previousHash: row.event_hash, previousPrevHash: row.prev_hash || null });
      }
      prevHash = eventHash;
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { /* preserve original error */ }
    throw e;
  } finally {
    client.release();
  }
  const tipHash = await appendEvent('chain_resealed', null, actor, { events, rewritten, previousTipHash, reason: why });
  return { events, rewritten: rewritten.length, repaired: rewritten, previousTipHash, tipHash };
}

module.exports = { resealEventChain };
