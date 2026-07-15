let roomId = Number(queryParam('id'));
const MATCH_CHECK_KEYS = ['md', 'wd', 'xd', 'ms', 'ws', 'xs'];
const COURT_MODE_KEYS = ['any', 'xd', 'md', 'wd', 'ms', 'ws', 'xs'];
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
    roomId = await resolveCurrentRoomId();
    if (!roomId) {
      window.location.href = '/rooms.html';
      return;
    }
    window.history.replaceState(null, '', `/room.html?id=${roomId}`);
  }

  renderUserAction(pageUser);
  document.body.insertAdjacentHTML('beforeend', bottomNav('room', pageUser));
  bindRoomPage();
  connectRoomSocket();
  await loadRoom();
})();

async function resolveCurrentRoomId() {
  try {
    const data = await api('/api/rooms/current');
    return data.room && Number(data.room.id) ? Number(data.room.id) : null;
  } catch {
    return null;
  }
}

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
  const { room, member, members, matches, freeProposals = [] } = payload;
  $('#roomTitle').textContent = room.name;
  $('#roomMeta').textContent = `${room.code} · ${room.court_count} 场地 · ${room.mode === 'round' ? '固定场次' : '自由匹配'}${room.venue_id && room.venue ? ` · ${room.venue.name} · ${formatVenueRange(room.venue)}` : ''}`;
  const isOwner = Number(room.owner_user_id) === pageUser.id;
  const canManageMembers = isOwner || pageUser.role === 'admin';
  renderVenueInfo(room.venue);

  renderPreferenceChecks(member ? member.match_preferences || member.match_preference : 'any', member && member.gender);
  renderStatus(member);
  renderStateForm(room, member);
  renderCourtModes(room.court_count);
  const freeSubmit = $('#freeMatchForm button[type="submit"]');
  const isInFreePool = member && member.match_pool_joined_at;
  if (freeSubmit) freeSubmit.textContent = isInFreePool ? '退出匹配池' : '参与匹配';
  renderMembers(members);
  renderMatches(matches);
  renderFreeProposals(freeProposals);
  renderRoomRegistrationList();

  $$('[data-mode-panel]').forEach((panel) => {
    panel.classList.toggle('hide', panel.dataset.modePanel !== room.mode);
  });
  $('#roundMatchForm').classList.toggle('hide', room.mode !== 'round' || !canManageMembers);
  $('#freeMatchForm').classList.toggle('hide', room.mode !== 'free' || !member);
  $('#leaveRoomBtn').classList.toggle('hide', isOwner || !member);
  $('#dissolveRoomBtn').classList.toggle('hide', !isOwner && pageUser.role !== 'admin');
  $('#toggleTemporaryMemberBtn').classList.toggle('hide', !canManageMembers);
  if (!canManageMembers) $('#temporaryMemberForm').classList.add('hide');
  $('#registrationForm').classList.toggle('hide', !canManageMembers || !room.venue_id);
}

function renderStateForm(room, member) {
  const isFreeRoom = room && room.mode === 'free';
  $('#stateForm').classList.toggle('hide', !member);
  $('#statusControls').classList.toggle('hide', !member || isFreeRoom);
  $('#saveStateBtn').textContent = isFreeRoom ? '保存偏好' : '保存状态';
  $('#preferenceHint').textContent = isFreeRoom
    ? '自由匹配只使用匹配偏好；是否参赛由匹配池按钮控制。'
    : '匹配偏好，可多选';
}

function renderVenueInfo(venue) {
  const card = $('#venueInfoCard');
  if (!venue) {
    card.classList.add('hide');
    card.classList.remove('venue-room-item');
    card.innerHTML = '';
    return;
  }
  card.classList.remove('hide');
  card.classList.add('venue-room-item');
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

function allowedMatchKeysForGender(gender) {
  if (gender === 'male') return ['md', 'xd', 'ms', 'xs'];
  if (gender === 'female') return ['wd', 'xd', 'ws', 'xs'];
  return MATCH_CHECK_KEYS;
}

function renderPreferenceChecks(raw, gender) {
  const keys = allowedMatchKeysForGender(gender);
  const values = matchPreferenceValues(raw);
  const selected = values.includes('any') ? new Set() : new Set(values);
  renderCheckGroup($('#preferenceChecks'), {
    keys,
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
  const gender = roomPayload && roomPayload.member && roomPayload.member.gender;
  return normalizeSelectedMatchTypes(values, allowedMatchKeysForGender(gender));
}

function selectedFreeMatchTypes(withDefault = true) {
  const values = checkedValues('freeMatchTypes');
  const normalized = normalizeSelectedMatchTypes(values);
  return normalized.length || !withDefault ? normalized : ['any'];
}

function normalizeSelectedMatchTypes(values, allowedKeys = MATCH_CHECK_KEYS) {
  const unique = [...new Set(values.filter((value) => allowedKeys.includes(value)))];
  if (unique.length === 0 || unique.length === allowedKeys.length) return ['any'];
  return unique;
}

function renderCourtModes(count) {
  const current = $$('#courtModes select').map((select) => select.value);
  $('#courtModes').innerHTML = Array.from({ length: Number(count) }, (_, index) => `
    <label>
      ${index + 1} 号场
      <select name="courtMode">
        ${COURT_MODE_KEYS.map((key) => `
          <option value="${key}" ${current[index] === key ? 'selected' : ''}>${MatchLabels[key]}</option>
        `).join('')}
      </select>
    </label>
  `).join('');
}

function renderFreeProposals(proposals) {
  const container = $('#freeProposalList');
  if (!container) return;
  container.innerHTML = proposals.length
    ? proposals.map(renderFreeProposalCard).join('')
    : '';
  $$('[data-accept-proposal]').forEach((button) => {
    button.addEventListener('click', () => acceptFreeProposal(button.dataset.acceptProposal));
  });
}

function renderFreeProposalCard(proposal) {
  const players = proposal.players || [];
  const red = players.filter((player) => player.team === 'red');
  const blue = players.filter((player) => player.team === 'blue');
  const me = players.find((player) => Number(player.user_id) === pageUser.id);
  const acceptedCount = players.filter((player) => player.accepted_at).length;
  const secondsLeft = Math.max(0, Math.ceil((new Date(proposal.expires_at).getTime() - Date.now()) / 1000));
  const canAccept = me && !me.accepted_at && secondsLeft > 0;

  return `
    <article class="item free-proposal">
      <div class="item-head">
        <div>
          <strong>${proposal.court_no || '-'} 号场 · ${escapeHtml(proposal.label || MatchLabels[proposal.match_type] || proposal.match_type)}</strong>
          <p class="meta">${secondsLeft} 秒内同意 · ${acceptedCount}/${players.length}</p>
        </div>
        ${canAccept ? `<button type="button" data-accept-proposal="${proposal.id}">同意</button>` : '<span class="pill waiting">等待同意</span>'}
      </div>
      <div class="team-board">
        <div class="team red">
          ${red.map(proposalPlayerLine).join('')}
        </div>
        <div class="team blue">
          ${blue.map(proposalPlayerLine).join('')}
        </div>
      </div>
    </article>
  `;
}

function proposalPlayerLine(player) {
  const isMine = Number(player.user_id) === pageUser.id;
  return `
    <div class="match-player ${isMine ? 'is-mine' : ''}">
      ${miniAvatarHtml(player)}
      <div>
        <strong>${escapeHtml(player.display_name)} ${ratingBadgeHtml(player.rating)}</strong>
        <small>Lv.${player.skill_level} · ${player.accepted_at ? '已同意' : '等待'}</small>
      </div>
    </div>
  `;
}

function renderRoomRegistrationList() {
  const container = $('#roomRegistrationList');
  if (!container || !roomPayload || !roomPayload.room.venue_id || !canManageVenueRoster(roomPayload)) return;

  renderRegisteredRoster();
  const memberIds = new Set(roomPayload.members.map((member) => Number(member.user_id)));
  const registrationIds = new Set((roomPayload.registrations || []).map((registration) => Number(registration.user_id)));
  const keyword = $('#roomRegistrationSearch').value.trim().toLowerCase();
  const users = managementOptions.users.filter((user) => {
    if (memberIds.has(Number(user.id)) || registrationIds.has(Number(user.id))) return false;
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

function renderRegisteredRoster() {
  const container = $('#registeredRosterList');
  if (!container) return;
  const registrations = roomPayload.registrations || [];
  container.innerHTML = registrations.length
    ? registrations.map((user) => `
      <div class="registration-chip">
        ${avatarHtml(user, 'small')}
        <span>${escapeHtml(user.display_name)}</span>
        <button type="button" class="secondary" data-remove-room-registration="${user.user_id}">移除</button>
      </div>
    `).join('')
    : '<p class="muted">还没有报名成员。</p>';

  $$('[data-remove-room-registration]').forEach((button) => {
    button.addEventListener('click', () => removeRoomRegistration(button.dataset.removeRoomRegistration));
  });
}

function renderMembers(members) {
  const canManageMembers = roomPayload
    && (Number(roomPayload.room.owner_user_id) === pageUser.id || pageUser.role === 'admin');
  const isFreeRoom = roomPayload && roomPayload.room && roomPayload.room.mode === 'free';
  const activeCount = isFreeRoom
    ? members.filter((member) => member.match_pool_joined_at || member.current_match_id).length
    : members.filter((member) => member.presence_status === 'online').length;
  $('#memberCount').textContent = `${activeCount}/${members.length}`;
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
  $$('[data-remove-room-member]').forEach((button) => {
    button.addEventListener('click', () => removeRoomMember(button.dataset.removeRoomMember));
  });
}

function renderMemberCard(member) {
  const canManageMembers = roomPayload
    && (Number(roomPayload.room.owner_user_id) === pageUser.id || pageUser.role === 'admin');
  const canRemoveMember = canRemoveRoomMember(member, canManageMembers);
  const isFreeRoom = roomPayload && roomPayload.room && roomPayload.room.mode === 'free';
  const presence = member.presence_status === 'online' ? '在线' : '离线';
  const tags = [
    member.account_type === 'temporary' ? '临时' : '',
    member.is_blacklisted ? '已拉黑' : ''
  ].filter(Boolean);

  return `
    <article class="member-card ${canRemoveMember ? 'can-remove' : ''}">
      ${canRemoveMember ? `<button type="button" class="member-delete-button" data-remove-room-member="${member.user_id}" aria-label="移除 ${escapeHtml(member.display_name)}">移除</button>` : ''}
      ${avatarHtml(member, 'member-avatar')}
      <div class="member-card-body">
        <div class="member-card-head">
          <strong>${escapeHtml(member.display_name)} ${ratingBadgeHtml(member.rating)}</strong>
          <p class="meta">偏好：${formatMatchPreferences(member.match_preferences || member.match_preference)}</p>
        </div>
        <p class="member-card-info">等级 ${member.skill_level} · ${isFreeRoom ? freeMemberPoolLabel(member) : presence}${tags.length ? ` · ${tags.join(' · ')}` : ''}</p>
        <p class="member-card-info">积分 ${member.rating} · ${GenderLabels[member.gender] || member.gender}</p>
        ${member.account_type === 'temporary' && member.username ? `<p class="member-username">用户名：${escapeHtml(member.username)}</p>` : ''}
        <div class="member-card-actions">
          ${isFreeRoom
            ? `<span class="member-status-pill ${freeMemberPoolClass(member)}">${freeMemberPoolLabel(member)}</span>`
            : (pageUser.role === 'admin' ? memberStatusSelect(member) : `<span class="member-status-pill ${member.play_status}">${StatusLabels[member.play_status] || member.play_status}</span>`)}
        </div>
      </div>
    </article>
  `;
}

function freeMemberPoolLabel(member) {
  if (member.current_match_id || member.play_status === 'in_match') return '比赛中';
  if (member.play_status === 'awaiting_result') return '待结果';
  if (member.match_pool_joined_at) return '匹配中';
  return '未参与';
}

function freeMemberPoolClass(member) {
  if (member.current_match_id || member.play_status === 'in_match') return 'active';
  if (member.play_status === 'awaiting_result') return 'waiting';
  if (member.match_pool_joined_at) return 'waiting';
  return 'idle';
}

function canRemoveRoomMember(member, canManageMembers) {
  if (!canManageMembers || !roomPayload || !roomPayload.room) return false;
  if (Number(member.user_id) === Number(roomPayload.room.owner_user_id)) return false;
  if (member.current_match_id || ['in_match', 'awaiting_result', 'locked'].includes(member.play_status)) return false;
  return member.presence_status === 'offline' || member.account_type === 'temporary';
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

async function removeRoomMember(userId) {
  if (!window.confirm('确认把这个成员移出房间？不会删除他的用户和比赛记录。')) return;
  try {
    await api(`/api/rooms/${roomId}/members/${userId}`, { method: 'DELETE' });
    await loadRoom();
  } catch (error) {
    showMessage(error.message);
  }
}

async function removeRoomRegistration(userId) {
  if (!window.confirm('确认把这个用户移出报名名单？')) return;
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
  const canForceFinish = (isOwner || pageUser.role === 'admin') && match.status === 'active';
  const isRealPlayer = me && me.account_type !== 'temporary';
  const canAct = (isRealPlayer || canJudgeAllTemporary || canForceFinish) && ['active', 'awaiting_result'].includes(match.status);
  const needsResult = match.status === 'awaiting_result'
    && ((isRealPlayer && !me.result_submitted) || canJudgeAllTemporary);
  const submitted = isRealPlayer && match.status === 'awaiting_result' && me.result_submitted;
  const resultText = match.status === 'invalid'
    ? `无效：${escapeHtml(match.invalid_reason || '结果冲突')}`
    : match.result_winner
      ? formatMatchResultText(match)
      : StatusLabels[match.status] || match.status;

  return `
    <article class="item match-record">
      <div class="item-head">
        <div>
          <strong>${formatMatchTitle(match)}</strong>
          <p class="meta">${formatMatchTiming(match)}</p>
        </div>
        <span class="pill ${match.status} ${winnerClass(match)}">${resultText}</span>
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

function winnerClass(match) {
  return {
    red: 'winner-red',
    blue: 'winner-blue',
    draw: 'winner-draw',
    terminated: 'winner-terminated',
    invalid: 'winner-invalid'
  }[match.result_winner] || '';
}

function miniAvatarHtml(player) {
  const gender = player.gender || 'other';
  const label = player.display_name || player.username || '?';
  const url = avatarUrlOf(player);
  return `<span class="avatar mini ${url ? 'avatar-thumb' : ''} ${gender}">${url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}">` : avatarText(label)}</span>`;
}

function displayCourtNo(match) {
  if (match.court_no) return Number(match.court_no);
  const room = roomPayload && roomPayload.room;
  const courtCount = Number(room && room.court_count);
  if (!courtCount || courtCount < 1) return null;
  const roundNo = Math.max(1, Number(match.round_no || 1));
  return ((roundNo - 1) % courtCount) + 1;
}

function formatMatchTitle(match) {
  const parts = [`第 ${match.round_no || 1} 轮`];
  const courtNo = displayCourtNo(match);
  if (courtNo) parts.push(`${courtNo} 号场`);
  parts.push(match.label || MatchLabels[match.match_type] || match.match_type);
  return parts.map(escapeHtml).join(' · ');
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
  if (endValue) {
    const end = new Date(endValue);
    if (!Number.isNaN(end.getTime())) {
      return `${formatMatchTime(match.started_at)}~${formatMatchTime(endValue)} 用时${formatDuration(end.getTime() - start.getTime())}`;
    }
  } else if (match.status === 'active') {
    return `${formatMatchTime(match.started_at)}~现在 已进行${formatDuration(Date.now() - start.getTime())}`;
  }
  return `${formatMatchTime(match.started_at)}~--:--`;
}

function formatMatchTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--';
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
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
  const isFreeRoom = roomPayload && roomPayload.room && roomPayload.room.mode === 'free';
  const body = {
    matchPreferences: selectedPreferences()
  };
  if (!isFreeRoom) {
    body.playStatus = data.playStatus;
  }
  try {
    await api(`/api/rooms/${roomId}/my-state`, {
      method: 'PATCH',
      body
    });
    showMessage(isFreeRoom ? '偏好已保存' : '状态已保存');
    await loadRoom();
  } catch (error) {
    showMessage(error.message);
  }
}

async function createFreeMatch(event) {
  event.preventDefault();
  try {
    const member = roomPayload && roomPayload.member;
    const isInPool = member && member.match_pool_joined_at;
    const poolData = await api(`/api/rooms/${roomId}/match/free${isInPool ? '/leave' : ''}`, {
      method: 'POST',
      body: {}
    });
    if (isInPool) {
      showMessage('已退出匹配池');
    } else if (poolData.matches && poolData.matches.length) {
      showMessage('匹配成功，比赛已开始');
    } else if (poolData.proposals && poolData.proposals.length) {
      showMessage('匹配成功，请等待所有人同意');
    } else if (poolData.status === 'waiting_court') {
      showMessage('场地已满，已进入等待');
    } else {
      showMessage('已加入匹配池');
    }
    await loadRoom();
    return;
    /*
    const data = await api(`/api/rooms/${roomId}/match/free`, {
      method: 'POST',
      body: { matchTypes: selectedFreeMatchTypes() }
    });
    showMessage(`已创建 ${MatchLabels[data.match.matchType] || '比赛'} 匹配`);
    await loadRoom();
    $('[data-tab="matchesPanel"]').click();
    */
  } catch (error) {
    showMessage(error.message);
  }
}

async function acceptFreeProposal(proposalId) {
  try {
    const data = await api(`/api/rooms/match-proposals/${proposalId}/accept`, { method: 'POST' });
    showMessage(data.status === 'matched' ? '比赛已开始' : '已同意，等待其他成员');
    await loadRoom();
    if (data.status === 'matched') $('[data-tab="matchesPanel"]').click();
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
