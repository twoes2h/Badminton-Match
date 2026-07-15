const { transaction } = require('../db');

const MATCH_TYPES = {
  md: { label: '男双', teamSize: 2, total: 4, needs: { male: 4 } },
  wd: { label: '女双', teamSize: 2, total: 4, needs: { female: 4 } },
  xd: { label: '混双', teamSize: 2, total: 4, needs: { male: 2, female: 2 } },
  ms: { label: '男单', teamSize: 1, total: 2, needs: { male: 2 } },
  ws: { label: '女单', teamSize: 1, total: 2, needs: { female: 2 } },
  xs: { label: '男女单打', teamSize: 1, total: 2, needs: { male: 1, female: 1 } }
};

const PLAYABLE_STATUSES = new Set(['idle', 'waiting', 'resting']);
const ROUND_PLAYABLE_STATUSES = new Set(['idle', 'waiting', 'resting']);
const ALL_MATCH_TYPE_KEYS = Object.keys(MATCH_TYPES);

function parseMatchPreferences(member) {
  const raw = member.match_preferences || member.match_preference || 'any';
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function acceptsMatchType(member, matchType) {
  const preferences = parseMatchPreferences(member);
  return preferences.length === 0 || preferences.includes('any') || preferences.includes(matchType);
}

function effectiveRating(member) {
  return Number(member.rating) + (Number(member.skill_level) - 5) * 40;
}

function candidatePriority(member) {
  const waitingBoost = member.play_status === 'waiting' ? -60 : 0;
  const restingPenalty = member.play_status === 'resting' ? 120 : 0;
  return (
    Number(member.matches_today || 0) * 35 +
    Number(member.consecutive_play_count || 0) * 55 -
    Number(member.rest_streak || 0) * 85 +
    restingPenalty +
    waitingBoost
  );
}

function combinations(items, size) {
  const out = [];
  const stack = [];

  function walk(start) {
    if (stack.length === size) {
      out.push(stack.slice());
      return;
    }
    for (let i = start; i <= items.length - (size - stack.length); i += 1) {
      stack.push(items[i]);
      walk(i + 1);
      stack.pop();
    }
  }

  walk(0);
  return out;
}

function canSatisfyNeeds(members, matchType) {
  const type = MATCH_TYPES[matchType];
  if (!type) return false;

  return Object.entries(type.needs).every(([gender, count]) => {
    return members.filter((member) => member.gender === gender).length >= count;
  });
}

function groupScore(participants, red, blue, pairCounts) {
  const redAvg = avg(red.map(effectiveRating));
  const blueAvg = avg(blue.map(effectiveRating));
  const spread = Math.max(...participants.map(effectiveRating)) - Math.min(...participants.map(effectiveRating));
  const repeatPenalty = sumPairCounts(participants, pairCounts) * 95;
  const loadPenalty = participants.reduce((sum, member) => {
    return (
      sum +
      Number(member.matches_today || 0) * 18 +
      Number(member.consecutive_play_count || 0) * 24 -
      Number(member.rest_streak || 0) * 35
    );
  }, 0);

  return Math.abs(redAvg - blueAvg) + spread * 0.08 + repeatPenalty + loadPenalty;
}

function avg(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
}

function pairKey(a, b) {
  const left = Math.min(Number(a), Number(b));
  const right = Math.max(Number(a), Number(b));
  return `${left}:${right}`;
}

function sumPairCounts(participants, pairCounts) {
  let total = 0;
  for (let i = 0; i < participants.length; i += 1) {
    for (let j = i + 1; j < participants.length; j += 1) {
      total += Number(pairCounts.get(pairKey(participants[i].user_id, participants[j].user_id)) || 0);
    }
  }
  return total;
}

function topByGender(members, gender, limit) {
  return members
    .filter((member) => member.gender === gender)
    .sort((a, b) => candidatePriority(a) - candidatePriority(b))
    .slice(0, limit);
}

async function loadEligibleMembers(conn, roomId, matchType, excludedIds = [], options = {}) {
  const includeOffline = Boolean(options.includeOffline);
  const requirePreferences = options.requirePreferences !== false;
  const allowedStatuses = options.allowedStatuses || PLAYABLE_STATUSES;
  const rows = await conn.query(
    `SELECT
       rm.room_id,
       rm.user_id,
       rm.play_status,
       rm.match_preference,
       rm.match_preferences,
       rm.consecutive_play_count,
       rm.rest_streak,
       u.username,
       u.display_name,
       u.gender,
       u.account_type,
       u.rating,
       u.skill_level,
       u.birth_year,
       (
         SELECT COUNT(*)
         FROM match_players mp
         JOIN matches m ON m.id = mp.match_id
         WHERE mp.user_id = u.id
           AND m.room_id = rm.room_id
           AND DATE(m.started_at) = CURDATE()
       ) AS matches_today
     FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = ?
       AND rm.left_at IS NULL
       ${includeOffline ? '' : "AND rm.presence_status = 'online'"}
       AND rm.current_match_id IS NULL
       AND u.is_blacklisted = 0`,
    [roomId]
  );

  const excluded = new Set(excludedIds.map(Number));
  return rows.filter((member) => {
    if (excluded.has(Number(member.user_id))) return false;
    if (!allowedStatuses.has(member.play_status)) return false;
    if (requirePreferences && !acceptsMatchType(member, matchType)) return false;
    return true;
  });
}

async function loadEligibleMemberIds(conn, roomId, options = {}) {
  const includeOffline = Boolean(options.includeOffline);
  const rows = await conn.query(
    `SELECT rm.user_id
     FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = ?
       AND rm.left_at IS NULL
       ${includeOffline ? '' : "AND rm.presence_status = 'online'"}
       AND rm.current_match_id IS NULL
       AND rm.play_status IN ('idle','waiting','resting')
       AND u.is_blacklisted = 0`,
    [roomId]
  );
  return rows.map((row) => Number(row.user_id));
}

async function loadTodayPairCounts(conn, roomId) {
  const rows = await conn.query(
    `SELECT
       LEAST(mp1.user_id, mp2.user_id) AS left_id,
       GREATEST(mp1.user_id, mp2.user_id) AS right_id,
       COUNT(*) AS pair_count
     FROM match_players mp1
     JOIN match_players mp2
       ON mp1.match_id = mp2.match_id
      AND mp1.user_id < mp2.user_id
     JOIN matches m ON m.id = mp1.match_id
     WHERE m.room_id = ?
       AND DATE(m.started_at) = CURDATE()
     GROUP BY left_id, right_id`,
    [roomId]
  );

  return new Map(rows.map((row) => [pairKey(row.left_id, row.right_id), Number(row.pair_count)]));
}

function restrictRestingFallback(members, matchType) {
  const nonResting = members.filter((member) => member.play_status !== 'resting');
  if (canSatisfyNeeds(nonResting, matchType)) return nonResting;
  return members;
}

function buildSameGenderDoubles(members, gender, pairCounts) {
  const pool = topByGender(members, gender, 24);
  const options = [];
  for (const group of combinations(pool, 4)) {
    const splits = [
      { red: [group[0], group[1]], blue: [group[2], group[3]] },
      { red: [group[0], group[2]], blue: [group[1], group[3]] },
      { red: [group[0], group[3]], blue: [group[1], group[2]] }
    ];
    for (const split of splits) {
      options.push({
        ...split,
        score: groupScore(group, split.red, split.blue, pairCounts)
      });
    }
  }
  return options;
}

function buildSingles(members, gender, pairCounts) {
  const pool = topByGender(members, gender, 28);
  return combinations(pool, 2).map((group) => {
    const red = [group[0]];
    const blue = [group[1]];
    return {
      red,
      blue,
      score: groupScore(group, red, blue, pairCounts)
    };
  });
}

function buildMixedSingles(members, pairCounts) {
  const males = topByGender(members, 'male', 24);
  const females = topByGender(members, 'female', 24);
  const options = [];
  for (const male of males) {
    for (const female of females) {
      const group = [male, female];
      const red = [male];
      const blue = [female];
      options.push({
        red,
        blue,
        score: groupScore(group, red, blue, pairCounts)
      });
    }
  }
  return options;
}

function buildMixedDoubles(members, pairCounts) {
  const males = topByGender(members, 'male', 16);
  const females = topByGender(members, 'female', 16);
  const options = [];

  for (const maleGroup of combinations(males, 2)) {
    for (const femaleGroup of combinations(females, 2)) {
      const group = [...maleGroup, ...femaleGroup];
      const splits = [
        { red: [maleGroup[0], femaleGroup[0]], blue: [maleGroup[1], femaleGroup[1]] },
        { red: [maleGroup[0], femaleGroup[1]], blue: [maleGroup[1], femaleGroup[0]] }
      ];
      for (const split of splits) {
        options.push({
          ...split,
          score: groupScore(group, split.red, split.blue, pairCounts)
        });
      }
    }
  }

  return options;
}

function skillLevelSpread(players) {
  if (!players.length) return 0;
  const levels = players.map((member) => Number(member.skill_level || 0));
  return Math.max(...levels) - Math.min(...levels);
}

function selectBestFromMembers(matchType, members, pairCounts, options = {}) {
  if (!MATCH_TYPES[matchType]) {
    throw new Error('不支持的匹配方式');
  }

  if (!canSatisfyNeeds(members, matchType)) {
    return null;
  }

  const builders = {
    md: () => buildSameGenderDoubles(members, 'male', pairCounts),
    wd: () => buildSameGenderDoubles(members, 'female', pairCounts),
    xd: () => buildMixedDoubles(members, pairCounts),
    ms: () => buildSingles(members, 'male', pairCounts),
    ws: () => buildSingles(members, 'female', pairCounts),
    xs: () => buildMixedSingles(members, pairCounts)
  };

  const builtOptions = builders[matchType]()
    .filter((option) => {
      const requiredUserIds = options.requiredUserIds || [];
      if (requiredUserIds.length) {
        const playerIds = new Set([...option.red, ...option.blue].map((member) => Number(member.user_id)));
        if (requiredUserIds.some((id) => !playerIds.has(Number(id)))) return false;
      }
      if (!Number.isFinite(Number(options.maxSkillSpread))) return true;
      return skillLevelSpread([...option.red, ...option.blue]) <= Number(options.maxSkillSpread);
    })
    .sort((a, b) => a.score - b.score);
  return builtOptions[0] || null;
}

async function selectBestMatch(conn, roomId, matchType, excludedIds = [], options = {}) {
  if (!MATCH_TYPES[matchType]) {
    throw new Error('涓嶆敮鎸佺殑鍖归厤鏂瑰紡');
  }

  const pairCounts = options.pairCounts || await loadTodayPairCounts(conn, roomId);
  const loadedMembers = await loadEligibleMembers(conn, roomId, matchType, excludedIds, options);
  const members = options.useRestingFallback === false
    ? loadedMembers
    : restrictRestingFallback(loadedMembers, matchType);
  return selectBestFromMembers(matchType, members, pairCounts, options);
}

async function selectBestAnyMatch(conn, roomId, matchTypes, excludedIds = [], options = {}) {
  const pairCounts = options.pairCounts || await loadTodayPairCounts(conn, roomId);
  const choices = [];
  for (const matchType of matchTypes) {
    if (!MATCH_TYPES[matchType]) continue;
    const teams = await selectBestMatch(conn, roomId, matchType, excludedIds, {
      ...options,
      pairCounts
    });
    if (teams) {
      choices.push({ matchType, teams, score: Number(teams.score || 0) });
    }
  }
  choices.sort((a, b) => a.score - b.score);
  return choices[0] || null;
}

async function assertRoomActive(conn, roomId) {
  const rows = await conn.query('SELECT * FROM rooms WHERE id = ? LIMIT 1', [roomId]);
  const room = rows[0];
  if (!room || room.status !== 'active') {
    throw new Error('房间不存在或已解散');
  }
  return room;
}

async function createMatch(conn, { roomId, matchType, teams, createdBy, courtNo = null, roundNo = 1 }) {
  const matchResult = await conn.query(
    `INSERT INTO matches (room_id, sport_key, match_type, court_no, round_no, created_by)
     SELECT id, sport_key, ?, ?, ?, ?
     FROM rooms
     WHERE id = ?`,
    [matchType, courtNo, roundNo, createdBy, roomId]
  );
  const matchId = Number(matchResult.insertId);
  const players = [
    ...teams.red.map((member) => ({ ...member, team: 'red' })),
    ...teams.blue.map((member) => ({ ...member, team: 'blue' }))
  ];

  for (const player of players) {
    await conn.query(
      `INSERT INTO match_players (match_id, user_id, team, rating_before)
       VALUES (?, ?, ?, ?)`,
      [matchId, player.user_id, player.team, player.rating]
    );
  }

  await conn.query(
    `UPDATE room_members
     SET play_status = 'in_match',
         current_match_id = ?,
         match_pool_joined_at = NULL,
         consecutive_play_count = consecutive_play_count + 1,
         rest_streak = 0
     WHERE room_id = ?
       AND user_id IN (${players.map(() => '?').join(',')})`,
    [matchId, roomId, ...players.map((player) => player.user_id)]
  );

  return {
    id: matchId,
    roomId,
    matchType,
    courtNo,
    roundNo,
    red: teams.red,
    blue: teams.blue
  };
}

async function nextAvailableCourtNo(conn, roomId, courtCount) {
  const totalCourts = Math.max(1, Number(courtCount || 1));
  const activeRows = await conn.query(
    `SELECT court_no
     FROM matches
     WHERE room_id = ?
       AND status IN ('active','awaiting_result')`,
    [roomId]
  );
  if (activeRows.length >= totalCourts) {
    throw new Error('当前没有空闲场地，请等待已有比赛结束');
  }

  const occupied = new Set(
    activeRows
      .map((row) => Number(row.court_no))
      .filter((courtNo) => courtNo >= 1 && courtNo <= totalCourts)
  );
  for (let courtNo = 1; courtNo <= totalCourts; courtNo += 1) {
    if (!occupied.has(courtNo)) return courtNo;
  }
  return (activeRows.length % totalCourts) + 1;
}

async function nextRoundNo(conn, roomId, mode = 'round') {
  const sql = mode === 'free'
    ? 'SELECT COUNT(*) + 1 AS next_round FROM matches WHERE room_id = ?'
    : 'SELECT COALESCE(MAX(round_no), 0) + 1 AS next_round FROM matches WHERE room_id = ?';
  const rows = await conn.query(sql, [roomId]);
  return Number(rows[0].next_round || 1);
}

async function createFreeMatch({ roomId, matchType, createdBy }) {
  return transaction(async (conn) => {
    const room = await assertRoomActive(conn, roomId);
    const matchTypes = Array.isArray(matchType) ? matchType : [matchType];
    const validTypes = [...new Set(matchTypes)].filter((type) => MATCH_TYPES[type]);
    if (validTypes.length === 0) {
      throw new Error('请至少选择一个匹配方式');
    }

    for (const type of validTypes) {
      const best = await selectBestMatch(conn, roomId, type);
      if (best) {
        const roundNo = await nextRoundNo(conn, roomId, room.mode);
        const courtNo = await nextAvailableCourtNo(conn, roomId, room.court_count);
        return createMatch(conn, {
          roomId,
          matchType: type,
          teams: best,
          createdBy,
          courtNo,
          roundNo
        });
      }
    }

    const labels = validTypes.map((type) => MATCH_TYPES[type].label).join('、');
    throw new Error(`当前房间没有足够适合 ${labels} 的空闲成员`);
  });
}

const FREE_POOL_CONFIRM_SECONDS = 15;
const FREE_POOL_IGNORE_SKILL_SECONDS = 30;
const FREE_POOL_IGNORE_PREFERENCE_SECONDS = 60;

function matchTypesForMember(member) {
  const preferences = parseMatchPreferences(member).filter((type) => MATCH_TYPES[type]);
  if (!preferences.length || parseMatchPreferences(member).includes('any')) return ALL_MATCH_TYPE_KEYS;
  return preferences;
}

async function expireStaleFreeProposals(conn, roomId) {
  const rows = await conn.query(
    `SELECT id
     FROM free_match_proposals
     WHERE room_id = ?
       AND status = 'pending'
       AND expires_at < NOW()
     FOR UPDATE`,
    [roomId]
  );
  if (!rows.length) return [];
  const ids = rows.map((row) => Number(row.id));
  await conn.query(
    `UPDATE free_match_proposals
     SET status = 'expired'
     WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  return ids;
}

async function nextFreePoolCourtNo(conn, roomId, courtCount) {
  const totalCourts = Math.max(1, Number(courtCount || 1));
  const rows = await conn.query(
    `SELECT court_no
     FROM matches
     WHERE room_id = ?
       AND status IN ('active','awaiting_result')
     UNION ALL
     SELECT court_no
     FROM free_match_proposals
     WHERE room_id = ?
       AND status = 'pending'
       AND expires_at >= NOW()`,
    [roomId, roomId]
  );
  if (rows.length >= totalCourts) return null;
  const occupied = new Set(
    rows
      .map((row) => Number(row.court_no))
      .filter((courtNo) => courtNo >= 1 && courtNo <= totalCourts)
  );
  for (let courtNo = 1; courtNo <= totalCourts; courtNo += 1) {
    if (!occupied.has(courtNo)) return courtNo;
  }
  return (rows.length % totalCourts) + 1;
}

async function loadFreePoolMembers(conn, roomId) {
  return conn.query(
    `SELECT
       rm.room_id,
       rm.user_id,
       rm.play_status,
       rm.match_preference,
       rm.match_preferences,
       rm.consecutive_play_count,
       rm.rest_streak,
       rm.match_pool_joined_at,
       TIMESTAMPDIFF(SECOND, COALESCE(rm.match_pool_joined_at, rm.last_seen_at, NOW()), NOW()) AS pool_wait_seconds,
       u.username,
       u.display_name,
       u.gender,
       u.account_type,
       u.rating,
       u.skill_level,
       u.birth_year,
       (
         SELECT COUNT(*)
         FROM match_players mp
         JOIN matches m ON m.id = mp.match_id
         WHERE mp.user_id = u.id
           AND m.room_id = rm.room_id
           AND DATE(m.started_at) = CURDATE()
       ) AS matches_today
     FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = ?
       AND rm.left_at IS NULL
       AND rm.current_match_id IS NULL
       AND rm.play_status NOT IN ('in_match','awaiting_result','locked')
       AND rm.match_pool_joined_at IS NOT NULL
       AND u.is_blacklisted = 0
       AND NOT EXISTS (
         SELECT 1
         FROM free_match_proposal_players fpp
         JOIN free_match_proposals fmp ON fmp.id = fpp.proposal_id
         WHERE fpp.user_id = rm.user_id
           AND fmp.room_id = rm.room_id
           AND fmp.status = 'pending'
           AND fmp.expires_at >= NOW()
       )
     ORDER BY rm.match_pool_joined_at ASC, rm.joined_at ASC`,
    [roomId]
  );
}

function chooseFreePoolProposal(candidates, pairCounts) {
  if (candidates.length < 2) return null;
  const anchor = candidates[0];
  const waitSeconds = Math.max(0, Number(anchor.pool_wait_seconds || 0));
  const ignoreSkill = waitSeconds >= FREE_POOL_IGNORE_SKILL_SECONDS;
  const ignorePreference = waitSeconds >= FREE_POOL_IGNORE_PREFERENCE_SECONDS;
  const matchTypes = ignorePreference ? ALL_MATCH_TYPE_KEYS : matchTypesForMember(anchor);

  for (const matchType of matchTypes) {
    const pool = candidates.filter((member) => (
      Number(member.user_id) === Number(anchor.user_id)
      || ignorePreference
      || acceptsMatchType(member, matchType)
    ));
    if (pool.length < MATCH_TYPES[matchType].total) continue;
    const teams = selectBestFromMembers(matchType, pool, pairCounts, {
      requiredUserIds: [anchor.user_id],
      maxSkillSpread: ignoreSkill ? undefined : 2
    });
    if (teams) {
      return {
        matchType,
        teams,
        waitSeconds,
        ignoredSkill: ignoreSkill,
        ignoredPreference: ignorePreference
      };
    }
  }

  return null;
}

async function createFreeMatchProposal(conn, { roomId, matchType, teams, createdBy, courtNo, roundNo }) {
  const result = await conn.query(
    `INSERT INTO free_match_proposals
       (room_id, match_type, court_no, round_no, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [roomId, matchType, courtNo, roundNo, createdBy, FREE_POOL_CONFIRM_SECONDS]
  );
  const proposalId = Number(result.insertId);
  const players = [
    ...teams.red.map((member) => ({ ...member, team: 'red' })),
    ...teams.blue.map((member) => ({ ...member, team: 'blue' }))
  ];
  let allAccepted = players.length > 0;
  for (const player of players) {
    const isTemporary = player.account_type === 'temporary';
    allAccepted = allAccepted && isTemporary;
    await conn.query(
      `INSERT INTO free_match_proposal_players (proposal_id, user_id, team, accepted_at)
       VALUES (?, ?, ?, CASE WHEN ? = 'temporary' THEN NOW() ELSE NULL END)`,
      [proposalId, player.user_id, player.team, player.account_type || 'normal']
    );
  }
  let match = null;
  if (allAccepted) {
    match = await createMatch(conn, {
      roomId,
      matchType,
      teams,
      createdBy,
      courtNo,
      roundNo
    });
    await conn.query(
      `UPDATE free_match_proposals
       SET status = 'accepted',
           accepted_match_id = ?
       WHERE id = ?`,
      [match.id, proposalId]
    );
  }
  return {
    id: proposalId,
    roomId,
    matchType,
    courtNo,
    roundNo,
    red: teams.red,
    blue: teams.blue,
    confirmSeconds: FREE_POOL_CONFIRM_SECONDS,
    autoMatched: Boolean(match),
    match
  };
}

async function evaluateFreeMatchPool(conn, roomId, createdBy) {
  const room = await assertRoomActive(conn, roomId);
  await expireStaleFreeProposals(conn, roomId);
  const proposals = [];
  const matches = [];

  while (true) {
    const courtNo = await nextFreePoolCourtNo(conn, roomId, room.court_count);
    if (!courtNo) {
      return {
        status: proposals.length ? 'proposal_created' : matches.length ? 'matched' : 'waiting_court',
        proposals,
        matches
      };
    }

    const candidates = await loadFreePoolMembers(conn, roomId);
    const pairCounts = await loadTodayPairCounts(conn, roomId);
    const selected = chooseFreePoolProposal(candidates, pairCounts);
    if (!selected) {
      return {
        status: proposals.length ? 'proposal_created' : matches.length ? 'matched' : 'waiting',
        proposals,
        matches
      };
    }

    const roundNo = await nextRoundNo(conn, roomId, room.mode);
    const proposal = await createFreeMatchProposal(conn, {
      roomId,
      matchType: selected.matchType,
      teams: selected.teams,
      createdBy,
      courtNo,
      roundNo
    });
    if (proposal.autoMatched && proposal.match) {
      matches.push(proposal.match);
    } else {
      proposals.push({
        ...proposal,
        waitSeconds: selected.waitSeconds,
        ignoredSkill: selected.ignoredSkill,
        ignoredPreference: selected.ignoredPreference
      });
    }
  }
}

async function joinFreeMatchPool({ roomId, userId }) {
  return transaction(async (conn) => {
    const room = await assertRoomActive(conn, roomId);
    if (room.mode !== 'free') {
      throw new Error('这个房间不是自由匹配模式');
    }
    const rows = await conn.query(
      `SELECT *
       FROM room_members
       WHERE room_id = ?
         AND user_id = ?
       LIMIT 1
       FOR UPDATE`,
      [roomId, userId]
    );
    const member = rows[0];
    if (!member || member.left_at) throw new Error('你还没有加入这个房间');
    if (member.current_match_id || ['in_match', 'awaiting_result', 'locked'].includes(member.play_status)) {
      throw new Error('当前状态不能加入匹配池');
    }
    await expireStaleFreeProposals(conn, roomId);
    await conn.query(
      `UPDATE room_members
       SET play_status = 'waiting',
           presence_status = 'online',
           match_pool_joined_at = COALESCE(match_pool_joined_at, NOW()),
           last_seen_at = NOW()
       WHERE room_id = ?
         AND user_id = ?`,
      [roomId, userId]
    );
    return evaluateFreeMatchPool(conn, roomId, userId);
  });
}

async function leaveFreeMatchPool({ roomId, userId }) {
  return transaction(async (conn) => {
    await expireStaleFreeProposals(conn, roomId);
    await conn.query(
      `UPDATE room_members
       SET play_status = 'idle',
           match_pool_joined_at = NULL,
           last_seen_at = NOW()
       WHERE room_id = ?
         AND user_id = ?
         AND current_match_id IS NULL`,
      [roomId, userId]
    );
    return evaluateFreeMatchPool(conn, roomId, userId);
  });
}

async function acceptFreeMatchProposal({ proposalId, userId }) {
  return transaction(async (conn) => {
    const proposalRows = await conn.query(
      `SELECT
         fmp.*,
         r.court_count,
         r.status AS room_status
       FROM free_match_proposals fmp
       JOIN rooms r ON r.id = fmp.room_id
       WHERE fmp.id = ?
       LIMIT 1
       FOR UPDATE`,
      [proposalId]
    );
    const proposal = proposalRows[0];
    if (!proposal || proposal.room_status !== 'active') throw new Error('匹配提议不存在或房间已解散');
    await expireStaleFreeProposals(conn, proposal.room_id);
    const freshRows = await conn.query(
      `SELECT status
       FROM free_match_proposals
       WHERE id = ?
       LIMIT 1`,
      [proposalId]
    );
    proposal.status = freshRows[0] ? freshRows[0].status : proposal.status;
    if (proposal.status !== 'pending') throw new Error('这个匹配提议已经失效');

    const playerRows = await conn.query(
      `SELECT *
       FROM free_match_proposal_players
       WHERE proposal_id = ?
         AND user_id = ?
       LIMIT 1
       FOR UPDATE`,
      [proposalId, userId]
    );
    if (!playerRows[0]) throw new Error('你不在这个匹配提议里');

    await conn.query(
      `UPDATE free_match_proposal_players
       SET accepted_at = COALESCE(accepted_at, NOW())
       WHERE proposal_id = ?
         AND user_id = ?`,
      [proposalId, userId]
    );

    const players = await conn.query(
      `SELECT
         fpp.user_id,
         fpp.team,
         fpp.accepted_at,
         u.username,
         u.display_name,
         u.gender,
         u.rating,
         u.skill_level,
         u.birth_year
       FROM free_match_proposal_players fpp
       JOIN users u ON u.id = fpp.user_id
       WHERE fpp.proposal_id = ?
       ORDER BY fpp.team, fpp.id`,
      [proposalId]
    );
    const allAccepted = players.length > 0 && players.every((player) => player.accepted_at);
    if (!allAccepted) {
      return { status: 'accepted_waiting', proposalId, roomId: Number(proposal.room_id) };
    }

    const courtNo = await nextAvailableCourtNo(conn, proposal.room_id, proposal.court_count);
    const teams = {
      red: players.filter((player) => player.team === 'red'),
      blue: players.filter((player) => player.team === 'blue')
    };
    const match = await createMatch(conn, {
      roomId: Number(proposal.room_id),
      matchType: proposal.match_type,
      teams,
      createdBy: proposal.created_by,
      courtNo,
      roundNo: proposal.round_no
    });
    await conn.query(
      `UPDATE free_match_proposals
       SET status = 'accepted',
           accepted_match_id = ?
       WHERE id = ?`,
      [match.id, proposalId]
    );
    return { status: 'matched', proposalId, roomId: Number(proposal.room_id), match };
  });
}

async function createRoundMatches({ roomId, courtModes, createdBy }) {
  return transaction(async (conn) => {
    const room = await assertRoomActive(conn, roomId);
    const courtCount = Math.max(1, Number(room.court_count || 1));
    const modes = Array.from({ length: courtCount }, (_, index) => {
      const mode = courtModes[index] || 'any';
      return mode === 'any' || MATCH_TYPES[mode] ? mode : 'any';
    });
    if (modes.length === 0) {
      throw new Error('请至少选择一个场地的匹配方式');
    }

    const roundNo = await nextRoundNo(conn, roomId);
    const roundOptions = {
      includeOffline: true,
      requirePreferences: false,
      useRestingFallback: false,
      allowedStatuses: ROUND_PLAYABLE_STATUSES
    };
    const roundEligibleIds = new Set(await loadEligibleMemberIds(conn, roomId, { includeOffline: true }));
    const excludedIds = new Set();
    const matches = [];
    const skipped = [];

    for (let i = 0; i < modes.length; i += 1) {
      const mode = modes[i];
      const selected = mode === 'any'
        ? await selectBestAnyMatch(conn, roomId, ALL_MATCH_TYPE_KEYS, [...excludedIds], roundOptions)
        : {
          matchType: mode,
          teams: await selectBestMatch(conn, roomId, mode, [...excludedIds], roundOptions)
        };
      if (!selected || !selected.teams) {
        skipped.push({
          courtNo: i + 1,
          matchType: mode,
          label: mode === 'any' ? '不限' : MATCH_TYPES[mode].label
        });
        continue;
      }

      const created = await createMatch(conn, {
        roomId,
        matchType: selected.matchType,
        teams: selected.teams,
        createdBy,
        courtNo: i + 1,
        roundNo
      });
      matches.push(created);
      for (const player of [...selected.teams.red, ...selected.teams.blue]) {
        excludedIds.add(Number(player.user_id));
      }
    }

    if (matches.length === 0) {
      throw new Error('本轮没有任何场地匹配成功，请调整场地模式或等待更多成员空闲');
    }

    const restingIds = [...roundEligibleIds].filter((id) => !excludedIds.has(id));
    if (restingIds.length > 0) {
      await conn.query(
        `UPDATE room_members
         SET rest_streak = rest_streak + 1,
             consecutive_play_count = 0
         WHERE room_id = ?
           AND user_id IN (${restingIds.map(() => '?').join(',')})`,
        [roomId, ...restingIds]
      );
    }

    return { roundNo, matches, skipped };
  });
}

module.exports = {
  MATCH_TYPES,
  acceptFreeMatchProposal,
  createFreeMatch,
  createRoundMatches,
  evaluateFreeMatchPool,
  joinFreeMatchPool,
  leaveFreeMatchPool,
  selectBestMatch
};
