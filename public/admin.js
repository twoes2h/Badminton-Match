let adminUser = null;
let adminUsers = [];

(async () => {
  adminUser = await requireUser({ admin: true });
  if (!adminUser) return;
  renderUserAction(adminUser);
  document.body.insertAdjacentHTML('beforeend', bottomNav('admin', adminUser));
  $('#refreshAdminBtn').addEventListener('click', loadAdminData);
  $('#announcementForm').addEventListener('submit', saveAnnouncement);
  $('#toggleVenueFormBtn').addEventListener('click', toggleVenueForm);
  $('#venueForm').addEventListener('submit', createVenue);
  $$('[name="roomStatusFilter"]').forEach((input) => {
    input.addEventListener('change', loadAdminData);
  });
  $('#userSearchInput').addEventListener('input', renderFilteredUsers);
  $('#userGenderFilter').addEventListener('change', renderFilteredUsers);
  $('#userLevelFilter').addEventListener('change', renderFilteredUsers);
  await loadAdminData();
})();

async function loadAdminData() {
  try {
    const roomStatus = $('[name="roomStatusFilter"]:checked').value;
    const venueStatus = roomStatus === 'dissolved' ? 'inactive' : 'active';
    syncAdminStatusView(roomStatus);
    const [roomData, userData, venueData, announcementData] = await Promise.all([
      api(`/api/admin/rooms?status=${encodeURIComponent(roomStatus)}`),
      api('/api/admin/users'),
      api(`/api/admin/venues?status=${encodeURIComponent(venueStatus)}`),
      api('/api/admin/announcement')
    ]);
    renderAnnouncement(announcementData.announcement);
    renderVenues(venueData.venues);
    renderRooms(roomData.rooms);
    adminUsers = userData.users;
    renderFilteredUsers();
  } catch (error) {
    showMessage(error.message);
  }
}

function syncAdminStatusView(roomStatus) {
  const isDissolved = roomStatus === 'dissolved';
  $('#announcementSection').classList.toggle('hide', isDissolved);
  $('#adminUsersSection').classList.toggle('hide', isDissolved);
  $('#toggleVenueFormBtn').classList.toggle('hide', isDissolved);
  $('#venueForm').classList.add('hide');
  $('#toggleVenueFormBtn').textContent = '添加场地';
}

function renderAnnouncement(announcement) {
  const form = $('#announcementForm');
  form.elements.title.value = announcement ? announcement.title || '' : '';
  form.elements.body.value = announcement ? announcement.body || '' : '';
  form.elements.isActive.checked = !announcement || Number(announcement.is_active) === 1;
}

function renderVenues(venues) {
  const roomStatus = $('[name="roomStatusFilter"]:checked').value;
  const archiveMode = roomStatus === 'dissolved';
  $('#venueList').innerHTML = venues.length
    ? venues.map((venue) => `
      <article class="item">
        <div class="item-head">
          <div>
            <strong>${escapeHtml(venue.name)}</strong>
            <p class="meta">${venue.court_count} 个球场 · ${formatDateTime(venue.starts_at)} - ${formatTime(venue.ends_at)}</p>
          </div>
          <span class="pill ${venue.status === 'inactive' ? 'locked' : ''}">${venue.status === 'inactive' ? '已停用' : '可用'}</span>
        </div>
        ${venue.location_url ? `<a class="button secondary" href="${escapeHtml(venue.location_url)}" target="_blank" rel="noreferrer">查看位置</a>` : ''}
        ${venue.active_room_id ? `<p class="meta">当前房间：${escapeHtml(venue.active_room_name)} · ${escapeHtml(venue.active_room_code)}</p>` : ''}
        ${archiveMode ? '<p class="meta">停用记录，仅查看</p>' : `
          <div class="row wrap">
            <button type="button" class="danger" data-disable-venue="${venue.id}" ${venue.active_room_id || venue.status === 'inactive' ? 'disabled' : ''}>停用</button>
          </div>
        `}
      </article>
    `).join('')
    : '<p class="muted">暂无场地。</p>';

  $$('[data-disable-venue]').forEach((button) => {
    button.addEventListener('click', () => disableVenue(button.dataset.disableVenue));
  });
}

function toggleVenueForm() {
  const form = $('#venueForm');
  form.classList.toggle('hide');
  $('#toggleVenueFormBtn').textContent = form.classList.contains('hide') ? '添加场地' : '收起';
}

function renderRooms(rooms) {
  const roomStatus = $('[name="roomStatusFilter"]:checked').value;
  if (roomStatus === 'dissolved') {
    renderDissolvedRooms(rooms);
    return;
  }

  $('#adminRooms').innerHTML = rooms.length
    ? rooms.map((room) => `
      <article class="item room-list-item ${room.venue_id ? 'venue-room-item' : 'standard-room-item'}">
        <div class="item-head">
          <div>
            <strong>${escapeHtml(room.name)}</strong>
            <p class="meta">${escapeHtml(room.code)} · ${room.status}</p>
          </div>
          <span class="pill">${room.online_count || 0}/${room.max_people}</span>
        </div>
        ${room.venue_id ? `<p class="meta">场地房间 · ${escapeHtml(room.venue_name || '')} · ${formatDateTime(room.venue_starts_at)} - ${formatTime(room.venue_ends_at)}</p>` : ''}
        <div class="two">
          <label>
            场地
            <input data-room-court="${room.id}" type="number" min="1" max="20" value="${room.court_count}">
          </label>
          <label>
            上限
            <input data-room-max="${room.id}" type="number" min="2" max="200" value="${room.max_people}">
          </label>
        </div>
        <div class="row wrap">
          ${roomStatus === 'active' ? `
            <button type="button" data-save-room="${room.id}">保存</button>
            <button type="button" class="danger" data-dissolve-room="${room.id}">解散</button>
          ` : '<span class="meta">已解散，仅保留履历</span>'}
        </div>
      </article>
    `).join('')
    : '<p class="muted">暂无房间。</p>';

  $$('[data-save-room]').forEach((button) => {
    button.addEventListener('click', () => saveRoom(button.dataset.saveRoom));
  });
  $$('[data-dissolve-room]').forEach((button) => {
    button.addEventListener('click', () => dissolveRoom(button.dataset.dissolveRoom));
  });
}

function renderDissolvedRooms(rooms) {
  if (!rooms.length) {
    $('#adminRooms').innerHTML = '<p class="muted">暂无已解散房间。</p>';
    return;
  }

  const groups = rooms.reduce((map, room) => {
    const key = monthKey(room.updated_at || room.created_at);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(room);
    return map;
  }, new Map());

  $('#adminRooms').innerHTML = [...groups.entries()].map(([month, monthRooms]) => `
    <details class="month-group">
      <summary>${month} · ${monthRooms.length} 个房间</summary>
      <div class="list">
        ${monthRooms.map(renderDissolvedRoom).join('')}
      </div>
    </details>
  `).join('');
}

function renderDissolvedRoom(room) {
  return `
    <article class="item">
      <div class="item-head">
        <div>
          <strong>${escapeHtml(room.name)}</strong>
          <p class="meta">${escapeHtml(room.code)} · ${room.mode === 'round' ? '固定场次' : '自由匹配'}</p>
        </div>
        <span class="pill">已解散</span>
      </div>
      <p class="meta">${room.court_count} 个场地 · 上限 ${room.max_people} 人 · 成员 ${room.member_count || 0} 人${room.venue_name ? ` · ${escapeHtml(room.venue_name)}` : ''}</p>
      <p class="meta">创建：${formatDateTime(room.created_at)}</p>
      <p class="meta">解散：${formatDateTime(room.updated_at)}</p>
    </article>
  `;
}

function monthKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知月份';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}年${month}月`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function renderFilteredUsers() {
  renderUsers(filterUsers(adminUsers));
}

function filterUsers(users) {
  const keyword = $('#userSearchInput').value.trim().toLowerCase();
  const gender = $('#userGenderFilter').value;
  const levelRange = $('#userLevelFilter').value;

  return users.filter((user) => {
    const text = `${user.display_name || ''} ${user.username || ''}`.toLowerCase();
    if (keyword && !text.includes(keyword)) return false;
    if (gender !== 'all' && user.gender !== gender) return false;
    if (levelRange !== 'all') {
      const [min, max] = levelRange.split('-').map(Number);
      const level = Number(user.skill_level || 0);
      if (level < min || level > max) return false;
    }
    return true;
  });
}

function renderUsers(users) {
  $('#adminUsers').innerHTML = users.length
    ? users.map(renderUserCard).join('')
    : '<p class="muted">暂无符合条件的用户。</p>';

  $$('[data-blacklist]').forEach((button) => {
    button.addEventListener('click', () => setBlacklist(button.dataset.blacklist, button.dataset.value === '1'));
  });
  $$('[data-role-user]').forEach((button) => {
    button.addEventListener('click', () => setRole(button.dataset.roleUser, button.dataset.roleValue));
  });
  $$('[data-force-logout]').forEach((button) => {
    button.addEventListener('click', () => forceLogout(button.dataset.forceLogout));
  });
}

function renderUserCard(user) {
  const statusLine = [
    user.username,
    user.is_blacklisted ? '已限制登录' : '可登录',
    user.role === 'admin' ? '管理员' : '',
    user.account_type === 'temporary' ? '临时' : ''
  ].filter(Boolean);
  const self = Number(user.id) === Number(adminUser.id);

  return `
    <article class="admin-user-card ${user.is_blacklisted ? 'is-locked' : ''}">
      ${avatarHtml(user, 'admin-avatar')}
      <div class="admin-user-body">
        <div>
          <strong>${escapeHtml(user.display_name)} ${ratingBadgeHtml(user.rating)}</strong>
          <p class="meta">${statusLine.map(escapeHtml).join(' · ')}</p>
        </div>
        <p class="admin-user-info">技术 ${user.skill_level}　积分 ${user.rating} · ${GenderLabels[user.gender] || '其他'}</p>
        <div class="admin-user-actions">
          <button type="button" class="secondary" data-role-user="${user.id}" data-role-value="${user.role === 'admin' ? 'user' : 'admin'}" ${self ? 'disabled' : ''}>
            ${user.role === 'admin' ? '取消管理' : '任命管理'}
          </button>
          <button type="button" class="${user.is_blacklisted ? 'secondary' : 'danger'}" data-blacklist="${user.id}" data-value="${user.is_blacklisted ? '0' : '1'}">
            ${user.is_blacklisted ? '解除拉黑' : '拉黑'}
          </button>
          <button type="button" class="admin-force-button" data-force-logout="${user.id}" ${self ? 'disabled' : ''}>下线</button>
        </div>
      </div>
    </article>
  `;
}

function avatarText(value) {
  const text = String(value || '?').trim();
  return escapeHtml([...text][0] || '?');
}

async function createVenue(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api('/api/admin/venues', {
      method: 'POST',
      body: formObject(form)
    });
    form.reset();
    form.courtCount.value = 3;
    form.classList.add('hide');
    $('#toggleVenueFormBtn').textContent = '添加场地';
    showMessage('场地已添加');
    await loadAdminData();
  } catch (error) {
    showMessage(error.message);
  }
}

async function saveAnnouncement(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api('/api/admin/announcement', {
      method: 'PUT',
      body: {
        title: form.elements.title.value,
        body: form.elements.body.value,
        isActive: form.elements.isActive.checked
      }
    });
    showMessage('公告已保存');
    await loadAdminData();
  } catch (error) {
    showMessage(error.message);
  }
}

async function disableVenue(venueId) {
  if (!window.confirm('确认停用这个场地？')) return;
  try {
    await api(`/api/admin/venues/${venueId}`, { method: 'DELETE' });
    await loadAdminData();
  } catch (error) {
    showMessage(error.message);
  }
}

async function saveRoom(roomId) {
  try {
    await api(`/api/admin/rooms/${roomId}`, {
      method: 'PATCH',
      body: {
        courtCount: $(`[data-room-court="${roomId}"]`).value,
        maxPeople: $(`[data-room-max="${roomId}"]`).value
      }
    });
    showMessage('房间已保存');
    await loadAdminData();
  } catch (error) {
    showMessage(error.message);
  }
}

async function dissolveRoom(roomId) {
  if (!window.confirm('确认解散房间？')) return;
  try {
    await api(`/api/admin/rooms/${roomId}`, { method: 'DELETE' });
    await loadAdminData();
  } catch (error) {
    showMessage(error.message);
  }
}

async function setBlacklist(userId, isBlacklisted) {
  try {
    await api(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      body: { isBlacklisted }
    });
    await loadAdminData();
  } catch (error) {
    showMessage(error.message);
  }
}

async function setRole(userId, role) {
  try {
    await api(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      body: { role }
    });
    await loadAdminData();
  } catch (error) {
    showMessage(error.message);
  }
}

async function forceLogout(userId) {
  if (!window.confirm('确认强制这个用户下线并退出房间？')) return;
  try {
    const data = await api(`/api/admin/users/${userId}/force-logout`, {
      method: 'POST'
    });
    showMessage(`已强制下线，清理 ${data.destroyedSessions || 0} 个登录会话`);
    await loadAdminData();
  } catch (error) {
    showMessage(error.message);
  }
}
