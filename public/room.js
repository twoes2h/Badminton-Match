const roomId = Number(queryParam('id'));
const MATCH_CHECK_KEYS = ['md', 'wd', 'xd', 'ms', 'ws', 'xs'];
let pageUser = null;
let roomPayload = null;
let socket = null;
let managementOptions = { users: [] };
let managementOptionsLoaded = false;
let selectedRoomRegistrationIds = new Set();

(async () => {
  pageUser = await requireUser();
  if (!pageUser) return;
  if (!roomId) {
    window.location.href = '/rooms.html';
    return;
  }

  renderUserAction(pageUser);
  document.body.insertAdjacentHTML('beforeend', bottomNav('room', pageUser));
  bindRoomPage();
  connectRoomSocket();
  await loadRoom();
})();

function bindRoomPage() {
  $$('.tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      $$('.tabs button').forEach((item) => item.classList.remove('active'));
      $$('.tab-panel').forEach((panel) => panel.classList.remove('active'));
      button.classList.add('active');
      $(`#${button.dataset.tab}`).classList.add('active');
    });
  });

  $('#stateForm').addEventListener('submit', saveState);
  $('#temporaryMemberForm').addEventListener('submit', createTemporaryMember);
  $('#toggleTemporaryMemberBtn').addEventListener('click', () => {
    $('#temporaryMemberForm').classList.remove('hide');
  });
  $('#hideTemporaryMemberBtn').addEventListener('click', () => {
    $('#temporaryMemberForm').classList.add('hide');
  });
  $('#registrationForm').addEventListener('submit', addRoomRegistrations);
  $('#roomRegistrationSearch').addEventListener('input', renderRoomRegistrationList);
  $('#freeMatchForm').addEventListener('submit', createFreeMatch);
  $('#roundMatchForm').addEventListener('submit', createRoundMatches);
  $('#leaveRoomBtn').addEventListener('click', leaveRoom);
  $('#dissolveRoomBtn').addEventListener('click', dissolveCurrentRoom);
  $('#refreshRoomBtn').addEventListener('click', loadRoom);
  $('#matchDateFilter').addEventListener('change', loadRoom);
  $('#clearMatchDateBtn').addEventListener('click', () => {
    $('#matchDateFilter').value = '';
    loadRoom();
  });
}

function connectRoomSocket() {
  if (typeof io === 'undefined') return;
  socket = io();
  socket.on('connect', () => socket.emit('room:join', roomId));
  socket.on('room:changed', (event) => {
    if (Number(event.roomId) === roomId) loadRoom();
  });
}

async function loadRoom() {
  try {
    const matchDate = $('#matchDateFilter') ? $('#matchDateFilter').value : '';
    const suffix = matchDate ? `?matchDate=${encodeURIComponent(matchDate)}` : '';
    roomPayload = await api(`/api/rooms/${roomId}${suffix}`);
    if (canManageVenueRoster(roomPayload)) {
      await ensureManagementOptions();
    }
    renderRoom(roomPayload);
  } catch (error) {
    showMessage(error.message);
  }
}

function renderRoom(payload) {
  const { room, member, members, matches } = payload;
  $('#roomTitle').textContent = room.name;
  $('#roomMeta').textContent = `${room.code} · ${room.court_count} 场地 · ${room.mode === 'round' ? '固定场次' : '自由匹配'}${room.venue_id && room.venue ? ` · ${room.venue.name} · ${formatVenueRange(room.venue)}` : ''}`;
  const isOwner = Number(room.owner_user_id) === pageUser.id;
  const canManageMembers = isOwner || pageUser.role === 'admin';
  renderVenueInfo(room.venue);

  renderPreferenceChecks(member ? member.match_preferences || member.match_preference : 'any');
  renderStatus(member);
  renderFreeMatchChecks();
  renderCourtModes(room.court_count);
  renderMembers(members);
  renderMatches(matches);
  renderRoomRegistrationList();

  $$('[data-mode-panel]').forEach((panel) => {
    panel.classList.toggle('hide', panel.dataset.modePanel !== room.mode);
  });
  $('#stateForm').classList.toggle('hide', !member);
  $('#leaveRoomBtn').classList.toggle('hide', isOwner || !member);
  $('#dissolveRoomBtn').classList.toggle('hide', !isOwner && pageUser.role !== 'admin');
  $('#toggleTemporaryMemberBtn').classList.toggle('hide', !canManageMembers);
  if (!canManageMembers) $('#temporaryMemberForm').classList.add('hide');
  $('#registrationForm').classList.toggle('hide', !canManageMembers || !room.venue_id);
}

function renderVenueInfo(venue) {
  const card = $('#venueInfoCard');
  if (!venue) {
    card.classList.add('hide');
    card.innerHTML = '';
    return;
  }
  card.classList.remove('hide');
  card.innerHTML = `
    <div class="card-title">
      <h2>${escapeHtml(venue.name)}</h2>
      <span class="pill">${venue.court_count} 场</span>
    </div>
    <p class="meta">${formatVenueRange(venue)}</p>
    ${venue.location_url ? `<a class="button secondary" href="${escapeHtml(venue.location_url)}" target="_blank" rel="noreferrer">查看位置</a>` : ''}
  `;
}

function canManageVenueRoster(payload) {
  if (!payload || !payload.room || !payload.room.venue_id) return false;
  return Number(payload.room.owner_user_id) === pageUser.id || pageUser.role === 'admin';
}

async function ensureManagementOptions() {
  if (managementOptionsLoaded) return;
  managementOptions = await api('/api/rooms/create-options');
  managementOptionsLoaded = true;
}

function renderStatus(member) {
  if (!member) return;
  const radio = $(`#stateForm [name="playStatus"][value="${member.play_status}"]`);
  if (radio) radio.checked = true;
}

function renderPreferenceChecks(raw) {
  const values = matchPreferenceValues(raw);
  const selected = values.includes('any') ? new Set() : new Set(values);
  renderCheckGroup($('#preferenceChecks'), {
    keys: MATCH_CHECK_KEYS,
    name: 'matchPreferences',
    prefix: 'pref',
    selected
  });
}

function renderFreeMatchChecks() {
  const current = selectedFreeMatchTypes(false);
  renderCheckGroup($('#freeMatchChecks'), {
    keys: MATCH_CHECK_KEYS,
    name: 'freeMatchTypes',
    prefix: 'free',
    selected: new Set(current.includes('any') ? [] : current)
  });
}

function renderCheckGroup(container, { keys, name, prefix, selected }) {
  container.innerHTML = keys.map((key) => `
    <input id="${prefix}-${key}" type="checkbox" name="${name}" value="${key}" ${selected.has(key) ? 'checked' : ''}>
    <label for="${prefix}-${key}">${MatchLabels[key]}</label>
  `).join('');
}

function checkedValues(name) {
  return $$(`[name="${name}"]:checked`).map((input) => input.value);
}

function selectedPreferences() {
  const values = checkedValues('matchPreferences');
  return normalizeSelectedMatchTypes(values);
}

function selectedFreeMatchTypes(withDefault = true) {
  const values = checkedValues('freeMatchTypes');
  const normalized = normalizeSelectedMatchTypes(values);
  return normalized.length || !withDefault ? normalized : ['any'];
}

function normalizeSelectedMatchTypes(values) {
  const unique = [...new Set(values.filter((value) => MATCH_CHECK_KEYS.includes(value)))];
  if (unique.length === 0 || unique.length === MATCH_CHECK_KEYS.length) return ['any'];
  return unique;
}

function renderCourtModes(count) {
  const current = $$('#courtModes select').map((select) => select.value);
  $('#courtModes').innerHTML = Array.from({ length: Number(count) }, (_, index) => `
    <label>
      ${index + 1} 号场
      <select name="courtMode">
        ${['xd', 'md', 'wd', 'ms', 'ws', 'xs'].map((key) => `
          <option value="${key}" ${current[index] === key ? 'selected' : ''}>${MatchLabels[key]}</option>
        `).join('')}
      </select>
    </label>
  `).join('');
}

function renderRoomRegistrationList() {
  const container = $('#roomRegistrationList');
  if (!container || !roomPayload || !roomPayload.room.venue_id || !canManageVenueRoster(roomPayload)) return;

  const memberIds = new Set(roomPayload.members.map((member) => Number(member.user_id)));
  const keyword = $('#roomRegistrationSearch').value.trim().toLowerCase();
  const users = managementOptions.users.filter((user) => {
    if (memberIds.has(Number(user.id))) return false;
    const text = `${user.display_name || ''} ${user.username || ''}`.toLowerCase();
    return !keyword || text.includes(keyword);
  });

  container.innerHTML = users.length
    ? users.map((user) => {
      const id = `room-register-${user.id}`;
      return `
        <input id="${id}" type="checkbox" value="${user.id}" ${selectedRoomRegistrationIds.has(Number(user.id)) ? 'checked' : ''}>
        <label for="${id}">
          ${avatarHtml(user, 'small')}
          <span>${escapeHtml(user.display_name)} ${ratingBadgeHtml(user.rating)}</span>
          <small>Lv.${user.skill_level} · ${user.rating}</small>
        </label>
      `;
    }).join('')
    : '<p class="muted">没有可添加的成员。</p>';

  $$('#roomRegistrationList input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const userId = Number(checkbox.value);
      if (checkbox.checked) selectedRoomRegistrationIds.add(userId);
      else selectedRoomRegistrationIds.delete(userId);
    });
  });
}

function renderMembers(members) {
  const canManageMembers = roomPayload
    && (Number(roomPayload.room.owner_user_id) === pageUser.id || pageUser.role === 'admin');
  $('#memberCount').textContent = `${members.filter((member) => member.presence_status === 'online').length}/${members.length}`;
  $('#memberList').innerHTML = members.map(renderMemberCard).join('');

  $$('[data-member-status]').forEach((select) => {
    select.addEventListener('change', async () => {
      try {
        await api(`/api/admin/rooms/${roomId}/members/${select.dataset.memberStatus}`, {
          method: 'PATCH',
          body: { playStatus: select.value }
        });
        await loadRoom();
      } catch (error) {
        showMessage(error.message);
      }
    });
  });
  $$('[data-remove-registration]').forEach((button) => {
    button.addEventListener('click', () => removeRoomRegistration(button.dataset.removeRegistration));
  });
}

function renderMemberCard(member) {
  const canManageMembers = roomPayload
    && (Number(roomPayload.room.owner_user_id) === pageUser.id || pageUser.role === 'admin');
  const presence = member.presence_status === 'online' ? '在线' : '离线';
  const tags = [
    member.account_type === 'temporary' ? '临时' : '',
    member.is_blacklisted ? '已拉黑' : ''
  ].filter(Boolean);

  return `
    <article class="member-card">
      ${avatarHtml(member, 'member-avatar')}
      <div class="member-card-body">
        <div class="member-card-head">
          <strong>${escapeHtml(member.display_name)} ${ratingBadgeHtml(member.rating)}</strong>
          <p class="meta">偏好：${formatMatchPreferences(member.match_preferences || member.match_preference)}</p>
        </div>
        <p class="member-card-info">等级 ${member.skill_level} · ${presence}${tags.length ? ` · ${tags.join(' · ')}` : ''}</p>
        <p class="member-card-info">积分 ${member.rating} · ${GenderLabels[member.gender] || member.gender}</p>
        ${member.account_type === 'temporary' && member.username ? `<p class="meta">用户名：${escapeHtml(member.username)} · 默认密码 000000</p>` : ''}
        <div class="member-card-actions">
          ${pageUser.role === 'admin' ? memberStatusSelect(member) : `<span class="member-status-pill ${member.play_status}">${StatusLabels[member.play_status] || member.play_status}</span>`}
          ${canManageMembers && roomPayload.room.venue_id ? `
            <button type="button" class="secondary member-remove-button" data-remove-registration="${member.user_id}">移出报名</button>
          ` : ''}
        </div>
      </div>
    </article>
  `;
}

function memberStatusSelect(member) {
  return `
    <select class="member-status-select" data-member-status="${member.user_id}" aria-label="成员状态">
      ${['idle', 'waiting', 'resting', 'busy', 'locked'].map((status) => `
        <option value="${status}" ${status === member.play_status ? 'selected' : ''}>${StatusLabels[status]}</option>
      `).join('')}
    </select>
  `;
}

async function createTemporaryMember(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const data = await api(`/api/rooms/${roomId}/temporary-members`, {
      method: 'POST',
      body: formObject(form)
    });
    form.reset();
    form.skillLevel.value = 5;
    form.rating.value = 1000;
    showMessage(`已添加 ${data.user.display_name}，用户名 ${data.user.username}，默认密码 ${data.defaultPassword}`);
    await loadRoom();
  } catch (error) {
    showMessage(error.message);
  }
}

async function addRoomRegistrations(event) {
  event.preventDefault();
  if (selectedRoomRegistrationIds.size === 0) {
    showMessage('请选择报名成员');
    return;
  }
  try {
    await api(`/api/rooms/${roomId}/registrations`, {
      method: 'POST',
      body: { userIds: [...selectedRoomRegistrationIds] }
    });
    selectedRoomRegistrationIds = new Set();
    $('#roomRegistrationSearch').value = '';
    showMessage('报名名单已更新');
    await loadRoom();
  } catch (error) {
    showMessage(error.message);
  }
}

async function removeRoomRegistration(userId) {
  if (!window.confirm('确认把这个成员移出报名名单？')) return;
  try {
    await api(`/api/rooms/${roomId}/registrations/${userId}`, { method: 'DELETE' });
    await loadRoom();
  } catch (error) {
    showMessage(error.message);
  }
}

function renderMatches(matches) {
  const groups = groupMatchesByDay(matches);
  const selectedDate = $('#matchDateFilter') ? $('#matchDateFilter').value : '';
  $('#matchList').innerHTML = groups.length
    ? groups.map(([dayKey, dayMatches], index) => `
      <details class="month-group match-day" ${shouldOpenMatchGroup(dayKey, index, selectedDate) ? 'open' : ''}>
        <summary>${formatMatchDayTitle(dayKey)} · ${dayMatches.length} 场</summary>
        <div class="list">${dayMatches.map(renderMatchCard).join('')}</div>
      </details>
    `).join('')
    : '<p class="muted">暂无比赛。</p>';

  $$('[data-finish-match]').forEach((button) => {
    button.addEventListener('click', () => finishMatch(button.dataset.finishMatch));
  });
  $$('[data-leave-match]').forEach((button) => {
    button.addEventListener('click', () => leaveMatch(button.dataset.leaveMatch));
  });
  $$('.result-form').forEach((form) => {
    form.addEventListener('submit', submitResult);
    $$('[name="resultMode"]', form).forEach((input) => {
      input.addEventListener('change', () => updateResultScoreFields(form));
    });
    updateResultScoreFields(form);
  });
}

function renderMatchCard(match) {
  const red = match.players.filter((player) => player.team === 'red');
  const blue = match.players.filter((player) => player.team === 'blue');
  const me = match.players.find((player) => Number(player.user_id) === pageUser.id);
  const isMine = Boolean(me);
  const room = roomPayload && roomPayload.room;
  const isOwner = room && Number(room.owner_user_id) === pageUser.id;
  const allTemporary = match.players.length > 0 && match.players.every((player) => player.account_type === 'temporary');
  const canJudgeAllTemporary = allTemporary && (isOwner || pageUser.role === 'admin');
  const isRealPlayer = me && me.account_type !== 'temporary';
  const canAct = (isRealPlayer || canJudgeAllTemporary) && ['active', 'awaiting_result'].includes(match.status);
  const needsResult = match.status === 'awaiting_result'
    && ((isRealPlayer && !me.result_submitted) || canJudgeAllTemporary);
  const submitted = isRealPlayer && match.status === 'awaiting_result' && me.result_submitted;
  const resultText = match.status === 'invalid'
    ? `无效：${escapeHtml(match.invalid_reason || '结果冲突')}`
    : match.result_winner
      ? formatMatchResultText(match)
      : StatusLabels[match.status] || match.status;

  return `
    <article class="item match-record ${isMine ? 'is-mine' : ''}">
      <div class="item-head">
        <div>
          <strong>${displayCourtNo(match) ? `${displayCourtNo(match)} 号场 · ` : ''}${escapeHtml(match.label || MatchLabels[match.match_type])}</strong>
          <p class="meta">第 ${match.round_no || 1} 轮 · ${formatMatchTiming(match)}</p>
        </div>
        <span class="pill ${match.status}">${resultText}</span>
      </div>
      <div class="team-board">
        <div class="team red">
          ${red.map(playerLine).join('')}
        </div>
        <div class="team blue">
          ${blue.map(playerLine).join('')}
        </div>
      </div>
      ${canAct ? `
        <div class="row wrap">
          ${match.status === 'active' ? `
            <button type="button" data-finish-match="${match.id}">结束</button>
            ${isRealPlayer ? `<button type="button" class="danger" data-leave-match="${match.id}">退出</button>` : ''}
          ` : ''}
          ${needsResult ? resultForm(match.id, { authority: canJudgeAllTemporary && !isRealPlayer }) : ''}
          ${submitted ? '<span class="meta">已提交，等待其他成员</span>' : ''}
        </div>
      ` : ''}
    </article>
  `;
}

function playerLine(player) {
  const isMine = Number(player.user_id) === pageUser.id;
  return `
    <div class="match-player ${isMine ? 'is-mine' : ''}">
      ${miniAvatarHtml(player)}
      <div>
        <strong>${escapeHtml(player.display_name)} ${ratingBadgeHtml(player.rating_before)}</strong>
        <small>${player.rating_before}${player.account_type === 'temporary' ? ' · 临时' : ''}${player.result_submitted ? ' · 已交' : ''}</small>
      </div>
    </div>
  `;
}

function miniAvatarHtml(player) {
  const gender = player.gender || 'other';
  const label = player.display_name || player.username || '?';
  return `<span class="avatar mini ${gender}">${avatarText(label)}</span>`;
}

function displayCourtNo(match) {
  if (match.court_no) return Number(match.court_no);
  const room = roomPayload && roomPayload.room;
  const courtCount = Number(room && room.court_count);
  if (!courtCount || courtCount < 1) return null;
  const roundNo = Math.max(1, Number(match.round_no || 1));
  return ((roundNo - 1) % courtCount) + 1;
}

function resultForm(matchId, options = {}) {
  const idPrefix = `result-${matchId}-${options.authority ? 'authority' : 'player'}`;
  const optionsHtml = options.authority
    ? [
      ['score', '比分'],
      ['red', '红方'],
      ['blue', '蓝方'],
      ['draw', '平'],
      ['terminated', '终止']
    ]
    : [
      ['score', '比分'],
      ['win', '赢'],
      ['lose', '输'],
      ['draw', '平'],
      ['terminated', '终止']
    ];

  return `
    <form class="result-form" data-result-match="${matchId}" data-authority="${options.authority ? '1' : '0'}">
      <div class="segmented result-choice">
        ${optionsHtml.map(([value, label], index) => `
          <input id="${idPrefix}-${value}" type="radio" name="resultMode" value="${value}" ${index === 0 ? 'checked' : ''}>
          <label for="${idPrefix}-${value}">${label}</label>
        `).join('')}
      </div>
      <div class="result-score-fields" data-score-fields>
        <input name="scoreRed" type="number" min="0" value="21" aria-label="红方比分">
        <input name="scoreBlue" type="number" min="0" value="21" aria-label="蓝方比分">
      </div>
      <button type="submit">提交结果</button>
    </form>
  `;
}

function updateResultScoreFields(form) {
  const mode = $('[name="resultMode"]:checked', form);
  const fields = $('[data-score-fields]', form);
  if (!mode || !fields) return;
  fields.classList.toggle('hide', mode.value !== 'score');
}

function groupMatchesByDay(matches) {
  const groups = new Map();
  for (const match of matches) {
    const key = matchDayKey(match.started_at);
    const list = groups.get(key) || [];
    list.push(match);
    groups.set(key, list);
  }
  return [...groups.entries()];
}

function shouldOpenMatchGroup(dayKey, index, selectedDate) {
  if (selectedDate) return dayKey === selectedDate || index === 0;
  return index === 0 || dayKey === matchDayKey(new Date());
}

function matchDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '未知日期';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatMatchDayTitle(dayKey) {
  if (dayKey === '未知日期') return dayKey;
  const date = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dayKey;
  const label = date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  });
  if (dayKey === matchDayKey(new Date())) return `${label} · 今天`;
  return label;
}

function formatMatchTiming(match) {
  if (!match || !match.started_at) return '时间未知';
  const start = new Date(match.started_at);
  if (Number.isNaN(start.getTime())) return '时间未知';
  const endValue = match.ended_at || match.finalized_at;
  const parts = [`匹配 ${formatMatchTime(match.started_at)}`];
  if (endValue) {
    const end = new Date(endValue);
    if (!Number.isNaN(end.getTime())) {
      parts.push(`结束 ${formatMatchTime(endValue)}`);
      parts.push(`用时 ${formatDuration(end.getTime() - start.getTime())}`);
    }
  } else if (match.status === 'active') {
    parts.push(`已进行 ${formatDuration(Date.now() - start.getTime())}`);
  }
  return parts.join(' · ');
}

function formatMatchTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '-';
  const totalMinutes = Math.max(1, Math.round(Math.max(0, milliseconds) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${totalMinutes}分钟`;
  return minutes ? `${hours}小时${minutes}分钟` : `${hours}小时`;
}

function formatVenueRange(venue) {
  if (!venue || !venue.starts_at || !venue.ends_at) return '-';
  const start = new Date(venue.starts_at);
  const end = new Date(venue.ends_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '-';
  const date = start.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  const startTime = start.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const endTime = end.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} ${startTime}-${endTime}`;
}

function winnerLabel(winner) {
  return {
    red: '红方胜',
    blue: '蓝方胜',
    draw: '平',
    terminated: '终止',
    invalid: '无效'
  }[winner] || winner;
}

function formatMatchResultText(match) {
  const base = winnerLabel(match.result_winner);
  if (match.score_red !== null && match.score_red !== undefined
    && match.score_blue !== null && match.score_blue !== undefined) {
    return `${base} · 红${match.score_red} 蓝${match.score_blue}`;
  }
  return base;
}

async function saveState(event) {
  event.preventDefault();
  const data = formObject(event.currentTarget);
  try {
    await api(`/api/rooms/${roomId}/my-state`, {
      method: 'PATCH',
      body: {
        playStatus: data.playStatus,
        matchPreferences: selectedPreferences()
      }
    });
    showMessage('状态已保存');
    await loadRoom();
  } catch (error) {
    showMessage(error.message);
  }
}

async function createFreeMatch(event) {
  event.preventDefault();
  try {
    const data = await api(`/api/rooms/${roomId}/match/free`, {
      method: 'POST',
      body: { matchTypes: selectedFreeMatchTypes() }
    });
    showMessage(`已创建 ${MatchLabels[data.match.matchType] || '比赛'} 匹配`);
    await loadRoom();
    $('[data-tab="matchesPanel"]').click();
  } catch (error) {
    showMessage(error.message);
  }
}

async function createRoundMatches(event) {
  event.preventDefault();
  try {
    const courtModes = $$('#courtModes select').map((select) => select.value);
    const data = await api(`/api/rooms/${roomId}/match/round`, {
      method: 'POST',
      body: { courtModes }
    });
    if (data.skipped && data.skipped.length) {
      showMessage(`成功 ${data.matches.length} 场，${data.skipped.length} 个场地未匹配`);
    }
    await loadRoom();
    $('[data-tab="matchesPanel"]').click();
  } catch (error) {
    showMessage(error.message);
  }
}

async function finishMatch(matchId) {
  try {
    await api(`/api/rooms/matches/${matchId}/finish`, { method: 'POST' });
    await loadRoom();
  } catch (error) {
    showMessage(error.message);
  }
}

async function leaveMatch(matchId) {
  try {
    await api(`/api/rooms/matches/${matchId}/leave`, { method: 'POST' });
    await loadRoom();
  } catch (error) {
    showMessage(error.message);
  }
}

async function submitResult(event) {
  event.preventDefault();
  const matchId = event.currentTarget.dataset.resultMatch;
  const form = event.currentTarget;
  const data = formObject(form);
  const resultMode = data.resultMode || 'score';
  const body = {};
  if (resultMode === 'score') {
    body.scoreRed = data.scoreRed;
    body.scoreBlue = data.scoreBlue;
  } else if (form.dataset.authority === '1') {
    body.verdict = resultMode;
  } else {
    body.outcome = resultMode;
  }
  try {
    const result = await api(`/api/rooms/matches/${matchId}/results`, {
      method: 'POST',
      body
    });
    showMessage(result.finalized ? '比赛已结算' : `已提交，等待 ${result.needed - result.submitted} 人`);
    await loadRoom();
  } catch (error) {
    showMessage(error.message);
  }
}

async function leaveRoom() {
  try {
    await api(`/api/rooms/${roomId}/leave`, { method: 'POST' });
    if (socket) socket.emit('room:leave', roomId);
    window.location.href = '/rooms.html';
  } catch (error) {
    showMessage(error.message);
  }
}

async function dissolveCurrentRoom() {
  if (!window.confirm('确认解散这个房间？房间会从普通列表消失，比赛履历会保留。')) return;
  try {
    await api(`/api/rooms/${roomId}`, { method: 'DELETE' });
    if (socket) socket.emit('room:leave', roomId);
    window.location.href = '/rooms.html';
  } catch (error) {
    showMessage(error.message);
  }
}
