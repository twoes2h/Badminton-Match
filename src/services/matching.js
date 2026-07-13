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

async function loadEligibleMembers(conn, roomId, matchType, excludedIds = []) {
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
       AND rm.presence_status = 'online'
       AND rm.current_match_id IS NULL
       AND u.is_blacklisted = 0`,
    [roomId]
  );

  const excluded = new Set(excludedIds.map(Number));
  return rows.filter((member) => {
    if (excluded.has(Number(member.user_id))) return false;
    if (!PLAYABLE_STATUSES.has(member.play_status)) return false;
    if (!acceptsMatchType(member, matchType)) return false;
    return true;
  });
}

async function loadEligibleMemberIds(conn, roomId) {
  const rows = await conn.query(
    `SELECT rm.user_id
     FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = ?
       AND rm.presence_status = 'online'
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

async function selectBestMatch(conn, roomId, matchType, excludedIds = []) {
  if (!MATCH_TYPES[matchType]) {
    throw new Error('不支持的匹配方式');
  }

  const pairCounts = await loadTodayPairCounts(conn, roomId);
  const members = restrictRestingFallback(
    await loadEligibleMembers(conn, roomId, matchType, excludedIds),
    matchType
  );

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

  const options = builders[matchType]().sort((a, b) => a.score - b.score);
  return options[0] || null;
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

async function createRoundMatches({ roomId, courtModes, createdBy }) {
  return transaction(async (conn) => {
    const room = await assertRoomActive(conn, roomId);
    const modes = courtModes.slice(0, Number(room.court_count)).filter((mode) => MATCH_TYPES[mode]);
    if (modes.length === 0) {
      throw new Error('请至少选择一个场地的匹配方式');
    }

    const roundNo = await nextRoundNo(conn, roomId);
    const roundEligibleIds = new Set(await loadEligibleMemberIds(conn, roomId));
    const excludedIds = new Set();
    const matches = [];
    const skipped = [];

    for (let i = 0; i < modes.length; i += 1) {
      const matchType = modes[i];
      const best = await selectBestMatch(conn, roomId, matchType, [...excludedIds]);
      if (!best) {
        skipped.push({ courtNo: i + 1, matchType, label: MATCH_TYPES[matchType].label });
        continue;
      }

      const created = await createMatch(conn, {
        roomId,
        matchType,
        teams: best,
        createdBy,
        courtNo: i + 1,
        roundNo
      });
      matches.push(created);
      for (const player of [...best.red, ...best.blue]) {
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
  createFreeMatch,
  createRoundMatches,
  selectBestMatch
};
