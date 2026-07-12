const MatchLabels = {
  any: '不限',
  md: '男双',
  wd: '女双',
  xd: '混双',
  ms: '男单',
  ws: '女单',
  xs: '男女单打'
};

const StatusLabels = {
  idle: '空闲',
  waiting: '等待',
  resting: '休息',
  busy: '忙碌',
  in_match: '比赛中',
  awaiting_result: '待成绩',
  locked: '锁定',
  active: '进行中',
  completed: '已完成',
  invalid: '无效',
  cancelled: '已取消'
};

const GenderLabels = {
  male: '男',
  female: '女',
  other: '其他'
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options,
    body: options.body && typeof options.body !== 'string'
      ? JSON.stringify(options.body)
      : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || '请求失败');
  }
  return data;
}

function showMessage(text) {
  const box = $('#message');
  if (!box) return;
  box.textContent = text || '';
  box.classList.toggle('show', Boolean(text));
  window.clearTimeout(showMessage.timer);
  if (text) {
    showMessage.timer = window.setTimeout(() => showMessage(''), 4200);
  }
}

function formObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function queryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

async function currentUser() {
  const data = await api('/api/auth/me');
  return {
    id: Number(data.user.id),
    username: data.user.username,
    displayName: data.user.display_name,
    role: data.user.role,
    accountType: data.user.account_type || 'normal'
  };
}

async function requireUser(options = {}) {
  try {
    const user = await currentUser();
    if (options.admin && user.role !== 'admin') {
      window.location.href = '/rooms.html';
      return null;
    }
    return user;
  } catch {
    window.location.href = '/login.html';
    return null;
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
}

function renderUserAction(user) {
  const el = $('#userAction');
  if (!el || !user) return;
  el.innerHTML = `
    <button class="secondary" type="button" id="logoutBtn">${escapeHtml(user.displayName)}</button>
  `;
  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await logout();
    } catch (error) {
      showMessage(error.message);
    }
  });
}

function bottomNav(active, user) {
  const links = [
    { key: 'rooms', href: '/rooms.html', label: '房间' },
    { key: 'room', href: queryParam('id') ? `/room.html?id=${queryParam('id')}` : '/rooms.html', label: '比赛' },
    { key: 'profile', href: '/profile.html', label: '我的' }
  ];
  if (user && user.role === 'admin') {
    links.push({ key: 'admin', href: '/admin.html', label: '管理' });
  }

  return `
    <nav class="bottom-nav" style="--nav-count:${links.length}">
      ${links.map((link) => `
        <a class="${active === link.key ? 'active' : ''}" href="${link.href}">${link.label}</a>
      `).join('')}
    </nav>
  `;
}

function matchPreferenceValues(raw) {
  const value = raw || 'any';
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function formatMatchPreferences(raw) {
  const values = matchPreferenceValues(raw);
  if (values.includes('any') || values.length === 0) return '不限';
  return values.map((value) => MatchLabels[value] || value).join('、');
}
