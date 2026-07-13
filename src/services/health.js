const { query, transaction } = require('../db');
const { finalizeTimedOutResults } = require('./results');

const STALE_ACTIVE_HOURS = 8;

async function healthSnapshot(options = {}) {
  const strict = Boolean(options.strict);
  const dbStartedAt = Date.now();
  await query('SELECT 1 AS ok');
  const dbLatencyMs = Date.now() - dbStartedAt;
  const [staleActive, staleAwaiting, orphanMembers, floatingStatuses] = await Promise.all([
    query(
      `SELECT COUNT(*) AS count_value
       FROM matches
       WHERE status = 'active'
         AND started_at <= DATE_SUB(NOW(), INTERVAL ${STALE_ACTIVE_HOURS} HOUR)`
    ),
    query(
      `SELECT COUNT(*) AS count_value
       FROM matches
       WHERE status = 'awaiting_result'
         AND ended_at IS NOT NULL
         AND ended_at <= DATE_SUB(NOW(), INTERVAL 10 MINUTE)`
    ),
    query(
      `SELECT COUNT(*) AS count_value
       FROM room_members rm
       LEFT JOIN matches m ON m.id = rm.current_match_id
       WHERE rm.current_match_id IS NOT NULL
         AND (m.id IS NULL OR m.room_id <> rm.room_id OR m.status IN ('completed','invalid','cancelled'))`
    ),
    query(
      `SELECT COUNT(*) AS count_value
       FROM room_members
       WHERE current_match_id IS NULL
         AND play_status IN ('in_match','awaiting_result')`
    )
  ]);

  const stuck = {
    staleActiveMatches: Number(staleActive[0].count_value || 0),
    staleAwaitingResults: Number(staleAwaiting[0].count_value || 0),
    orphanMemberMatches: Number(orphanMembers[0].count_value || 0),
    floatingMemberStatuses: Number(floatingStatuses[0].count_value || 0)
  };
  const stuckCount = Object.values(stuck).reduce((sum, value) => sum + value, 0);

  return {
    ok: !strict || stuckCount === 0,
    db: { ok: true, latencyMs: dbLatencyMs },
    stuck,
    strict,
    ts: new Date().toISOString()
  };
}

async function repairStuckState() {
  const timedOut = await finalizeTimedOutResults();
  return transaction(async (conn) => {
    const staleMatches = await conn.query(
      `SELECT id, room_id
       FROM matches
       WHERE status = 'active'
         AND started_at <= DATE_SUB(NOW(), INTERVAL ${STALE_ACTIVE_HOURS} HOUR)
       FOR UPDATE`
    );
    const staleMatchIds = staleMatches.map((match) => Number(match.id));
    const staleRoomIds = staleMatches.map((match) => Number(match.room_id));

    if (staleMatchIds.length) {
      await conn.query(
        `UPDATE matches
         SET status = 'cancelled',
             result_winner = 'terminated',
             ended_at = COALESCE(ended_at, DATE_SUB(NOW(), INTERVAL 1 MINUTE)),
             finalized_at = COALESCE(finalized_at, NOW()),
             invalid_reason = COALESCE(invalid_reason, '系统自检取消超时未结束比赛')
         WHERE id IN (${staleMatchIds.map(() => '?').join(',')})`,
        staleMatchIds
      );
      await conn.query(
        `UPDATE room_members
         SET play_status = 'idle',
             current_match_id = NULL
         WHERE current_match_id IN (${staleMatchIds.map(() => '?').join(',')})`,
        staleMatchIds
      );
    }

    const orphanResult = await conn.query(
      `UPDATE room_members rm
       LEFT JOIN matches m ON m.id = rm.current_match_id
       SET rm.play_status = 'idle',
           rm.current_match_id = NULL
       WHERE rm.current_match_id IS NOT NULL
         AND (m.id IS NULL OR m.room_id <> rm.room_id OR m.status IN ('completed','invalid','cancelled'))`
    );

    const floatingResult = await conn.query(
      `UPDATE room_members
       SET play_status = 'idle'
       WHERE current_match_id IS NULL
         AND play_status IN ('in_match','awaiting_result')`
    );

    return {
      timedOut: timedOut.finalized,
      cancelledStaleMatches: staleMatchIds,
      roomIds: [...new Set([...timedOut.roomIds, ...staleRoomIds])],
      orphanMembersReleased: Number(orphanResult.affectedRows || 0),
      floatingStatusesReleased: Number(floatingResult.affectedRows || 0)
    };
  });
}

module.exports = {
  healthSnapshot,
  repairStuckState,
  STALE_ACTIVE_HOURS
};
