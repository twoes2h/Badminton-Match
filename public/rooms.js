let pageUser = null;
let createOptions = { venues: [], users: [] };
let selectedCreateRegistrationIds = new Set();
let currentAnnouncement = null;

(async () => {
  pageUser = await requireUser();
  if (!pageUser) return;

  renderUserAction(pageUser);
  document.body.insertAdjacentHTML('beforeend', bottomNav('rooms', pageUser));
  bindRoomsPage();
  await loadAnnouncement();
  if (pageUser.role === 'admin') await loadCreateOptions();
  await loadRooms();
})();

function bindRoomsPage() {
  $('#searchRoomForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await loadRooms(formObject(event.currentTarget).q || '');
  });

  $('#refreshRoomsBtn').addEventListener('click', () => loadRooms());
  $('#announcementBtn').addEventListener('click', () => showAnnouncement());
  $('#announcementOverlay').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) hideAnnouncement();
  });
  $('#toggleCreateRoomBtn').addEventListener('click', () => {
    const form = $('#createRoomForm');
    form.classList.toggle('hide');
    $('#toggleCreateRoomBtn').textContent = form.classList.contains('hide') ? '创建' : '收起';
  });
  $('#venueSelect').addEventListener('change', renderVenueCreateSelection);
  $('#registrationSearch').addEventListener('input', renderCreateRegistrationList);

  $('#createRoomForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const body = formObject(event.currentTarget);
      body.registeredUserIds = [...selectedCreateRegistrationIds];
      const data = await api('/api/rooms', {
        method: 'POST',
        body
      });
      window.location.href = `/room.html?id=${data.room.id}`;
    } catch (error) {
      showMessage(error.message);
    }
  });
}

async function loadAnnouncement() {
  try {
    const data = await api('/api/announcements/current');
    currentAnnouncement = data.announcement;
    if (!currentAnnouncement) {
      $('#announcementBtn').classList.add('hide');
      hideAnnouncement();
      return;
    }

    $('#announcementBtn').classList.remove('hide');
    renderAnnouncementModal();
    const seenKey = announcementSeenKey(currentAnnouncement);
    if (window.localStorage.getItem(seenKey) !== '1') {
      showAnnouncement();
    }
  } catch (error) {
    showMessage(error.message);
  }
}

function announcementSeenKey(announcement) {
  return `badminton-announcement:${announcement.id}:${announcement.updated_at}`;
}

function renderAnnouncementModal() {
  $('#announcementOverlay').innerHTML = `
    <div class="card announcement-modal">
      <div class="card-title">
      <h2>${escapeHtml(currentAnnouncement.title || '公告')}</h2>
        <button id="closeAnnouncementBtn" type="button" class="secondary">关闭</button>
      </div>
      <p>${escapeHtml(currentAnnouncement.body || '').replace(/\n/g, '<br>')}</p>
    </div>
  `;
  $('#closeAnnouncementBtn').addEventListener('click', () => {
    hideAnnouncement();
  });
}

function showAnnouncement() {
  if (!currentAnnouncement) return;
  renderAnnouncementModal();
  $('#announcementOverlay').classList.remove('hide');
  window.localStorage.setItem(announcementSeenKey(currentAnnouncement), '1');
}

function hideAnnouncement() {
  const overlay = $('#announcementOverlay');
  if (overlay) overlay.classList.add('hide');
}

async function loadCreateOptions() {
  try {
    createOptions = await api('/api/rooms/create-options');
    $('#venueCreateBox').classList.remove('hide');
    renderVenueOptions();
    renderCreateRegistrationList();
  } catch (error) {
    showMessage(error.message);
  }
}

function renderVenueOptions() {
  $('#venueSelect').innerHTML = `
    <option value="">普通房间，不绑定场地</option>
    ${createOptions.venues.map((venue) => `
      <option value="${venue.id}">${escapeHtml(venue.name)} · ${formatVenueRange(venue)}</option>
    `).join('')}
  `;
  renderVenueCreateSelection();
}

function selectedVenue() {
  const venueId = Number($('#venueSelect').value || 0);
  return createOptions.venues.find((venue) => Number(venue.id) === venueId) || null;
}

function renderVenueCreateSelection() {
  const venue = selectedVenue();
  const form = $('#createRoomForm');
  form.courtCount.disabled = Boolean(venue);
  if (venue) form.courtCount.value = venue.court_count;
  $('#venueRosterBox').classList.toggle('hide', !venue);
  $('#venueCreateMeta').innerHTML = venue
    ? `${venue.court_count} 个球场 · ${formatVenueRange(venue)}${venue.location_url ? ` · <a href="${escapeHtml(venue.location_url)}" target="_blank" rel="noreferrer">位置</a>` : ''}`
    : '不选择场地时创建普通房间。';
}

function renderCreateRegistrationList() {
  const keyword = $('#registrationSearch').value.trim().toLowerCase();
  const users = createOptions.users.filter((user) => {
    const text = `${user.display_name || ''} ${user.username || ''}`.toLowerCase();
    return !keyword || text.includes(keyword);
  });

  $('#createRegistrationList').innerHTML = users.length
    ? users.map((user) => {
      const id = `create-register-${user.id}`;
      return `
        <input id="${id}" type="checkbox" value="${user.id}" ${selectedCreateRegistrationIds.has(Number(user.id)) ? 'checked' : ''}>
        <label for="${id}">
          ${avatarHtml(user, 'small')}
          <span>${escapeHtml(user.display_name)} ${ratingBadgeHtml(user.rating)}</span>
          <small>Lv.${user.skill_level} · ${user.rating}</small>
        </label>
      `;
    }).join('')
    : '<p class="muted">没有符合条件的成员。</p>';

  $$('#createRegistrationList input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const userId = Number(checkbox.value);
      if (checkbox.checked) selectedCreateRegistrationIds.add(userId);
      else selectedCreateRegistrationIds.delete(userId);
    });
  });
}

async function loadRooms(q = '') {
  try {
    const data = await api(`/api/rooms${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    $('#roomList').innerHTML = data.rooms.length
      ? data.rooms.map(renderRoomItem).join('')
      : '<p class="muted">暂无房间，可以先创建一个。</p>';

    $$('[data-join-room]').forEach((button) => {
      button.addEventListener('click', () => joinRoom(button.dataset.joinRoom, button.dataset.hasPassword === '1'));
    });
  } catch (error) {
    showMessage(error.message);
  }
}

function renderRoomItem(room) {
  const isVenueRoom = Boolean(room.venue_id);
  const isOwner = Number(room.owner_user_id) === Number(pageUser.id);
  const adminGuest = pageUser.role === 'admin' && !isOwner;
  return `
    <article class="item room-list-item ${isVenueRoom ? 'venue-room-item' : 'standard-room-item'}">
      <div class="item-head">
        <div>
          <strong>${escapeHtml(room.name)}</strong>
          <p class="meta">${escapeHtml(room.code)} · ${room.mode === 'round' ? '固定场次' : '自由匹配'}${isVenueRoom ? ' · 场地房间' : ''}${Number(room.has_password) === 1 ? ' · 有密码' : ''}</p>
        </div>
        <span class="pill">${room.online_count || 0}/${room.max_people}</span>
      </div>
      <p class="meta">${room.court_count} 个场地</p>
      ${isVenueRoom ? `
        <p class="meta">${escapeHtml(room.venue_name || '')} · ${formatVenueRange({ starts_at: room.venue_starts_at, ends_at: room.venue_ends_at })}</p>
        ${room.venue_location_url ? `<a class="button secondary" href="${escapeHtml(room.venue_location_url)}" target="_blank" rel="noreferrer">查看位置</a>` : ''}
      ` : ''}
      <p class="message room-card-message" data-room-message="${room.id}"></p>
      ${adminGuest
        ? `<button type="button" data-join-room="${room.id}" data-has-password="0">管理房间</button>`
        : `<button type="button" data-join-room="${room.id}" data-has-password="${Number(room.has_password) === 1 ? '1' : '0'}">进入房间</button>`}
    </article>
  `;
}

async function joinRoom(roomId, hasPassword) {
  const password = hasPassword ? window.prompt('房间密码') || '' : '';
  try {
    await api(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      body: { password }
    });
    window.location.href = `/room.html?id=${roomId}`;
  } catch (error) {
    showRoomMessage(roomId, error.message);
  }
}

function showRoomMessage(roomId, text) {
  const roomIdText = String(roomId);
  const box = $$('[data-room-message]').find((element) => element.dataset.roomMessage === roomIdText);
  if (!box) {
    showMessage(text);
    return;
  }

  box.textContent = text || '';
  box.classList.toggle('show', Boolean(text));
  showRoomMessage.timers = showRoomMessage.timers || new Map();
  window.clearTimeout(showRoomMessage.timers.get(roomIdText));
  if (text) {
    showRoomMessage.timers.set(roomIdText, window.setTimeout(() => showRoomMessage(roomIdText, ''), 5200));
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
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
