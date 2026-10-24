const STATUS_META = {
  connected: { label: 'Connected', dot: '#189a54', text: '#189a54' },
  qr_pending: { label: 'Awaiting scan', dot: '#d97706', text: '#d97706' },
  connecting: { label: 'Connecting', dot: '#d97706', text: '#d97706' },
  disconnected: { label: 'Disconnected', dot: '#6b7280', text: '#6b7280' },
  logged_out: { label: 'Logged out', dot: '#dc2626', text: '#dc2626' },
  created: { label: 'Not started', dot: '#6b7280', text: '#6b7280' },
};

const params = new URLSearchParams(window.location.search);
const instanceId = params.get('id');
let instance = null;
let messages = [];
let availableGroups = [];
let selectedGroupIds = [];

function renderHeader() {
  document.getElementById('instance-name-title').textContent = instance.name;
  const meta = STATUS_META[instance.status] || STATUS_META.created;
  document.getElementById('status-row').innerHTML = `
    <span class="status-dot" style="background:${meta.dot};"></span>
    <span style="font-size:14px;font-weight:500;color:${meta.text};">${meta.label}</span>
    ${instance.phoneNumber ? `<span class="mono hint-text">· +${instance.phoneNumber}</span>` : ''}
  `;
  document.getElementById('connect-btn').style.display = instance.status === 'connected' ? 'none' : 'inline-flex';
  document.getElementById('disconnect-btn').style.display = instance.status === 'connected' ? 'inline-flex' : 'none';
  document.getElementById('test-send-btn').disabled = instance.status !== 'connected';
}

function renderQr(qrDataUrl) {
  const area = document.getElementById('qr-area');
  if (qrDataUrl) {
    area.innerHTML = `<div class="qr-wrap"><img src="${qrDataUrl}" alt="WhatsApp QR code" /></div>`;
  } else if (instance.status === 'connected') {
    area.innerHTML = `
      <div style="width:224px;height:224px;border-radius:12px;background:var(--signal-50);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--signal-500)" stroke-width="2"><path d="M9 12l2 2 4-4"/><path d="M21 12a9 9 0 1 1-9-9"/></svg>
        <p style="color:var(--signal-600);font-weight:500;font-size:14px;">Linked and active</p>
      </div>`;
  } else {
    area.innerHTML = `
      <div style="width:224px;height:224px;border-radius:12px;border:1px dashed var(--canvas-border);display:flex;align-items:center;justify-content:center;">
        <p class="hint-text" style="padding:0 24px;">Press Connect to generate a QR code</p>
      </div>`;
  }
}

function renderProxy() {
  document.getElementById('proxy-toggle').checked = !!instance.useProxy;
  document.getElementById('proxy-current').textContent = instance.proxyUrl ? `Current: ${instance.proxyUrl}` : '';
}

function renderWebhookForm() {
  document.getElementById('webhook-url').value = instance.webhookUrl || '';
  document.getElementById('include-groups').checked = !!instance.includeGroupMessages;
  document.getElementById('include-own').checked = !!instance.includeOwnMessages;
  document.getElementById('webhook-secret').textContent = instance.webhookSecret || '';
}

// ---------- Groups ----------

function renderGroups() {
  const status = document.getElementById('groups-status');
  const list = document.getElementById('group-list');
  const term = document.getElementById('group-search').value.trim().toLowerCase();

  list.replaceChildren();

  const visible = availableGroups.filter((g) => !term || g.name.toLowerCase().includes(term));

  status.textContent = availableGroups.length
    ? `${availableGroups.length} groups available · ${selectedGroupIds.length} selected`
    : 'No groups returned. Make sure the instance is connected.';

  for (const group of visible) {
    const label = document.createElement('label');
    label.className = 'checkbox-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = group.id;
    checkbox.checked = selectedGroupIds.includes(group.id);

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        selectedGroupIds = [...new Set([...selectedGroupIds, group.id])];
      } else {
        selectedGroupIds = selectedGroupIds.filter((id) => id !== group.id);
      }
      status.textContent = `${availableGroups.length} groups available · ${selectedGroupIds.length} selected (not saved yet)`;
    });

    const name = document.createElement('span');
    name.style.flex = '1';
    name.style.fontSize = '14px';
    name.textContent = group.name; // textContent: group names are never treated as HTML

    const count = document.createElement('span');
    count.className = 'hint-text';
    count.textContent = group.participantsCount == null ? '' : `${group.participantsCount} members`;

    label.append(checkbox, name, count);
    list.append(label);
  }
}

async function loadGroups({ refresh = false } = {}) {
  const status = document.getElementById('groups-status');
  const list = document.getElementById('group-list');

  status.textContent = 'Loading groups…';
  list.replaceChildren();

  try {
    const data = await api.get(`/instances/${instanceId}/groups${refresh ? '?refresh=1' : ''}`);
    availableGroups = data.groups || [];
    selectedGroupIds = data.selectedGroupIds || [];
    renderGroups();
  } catch (err) {
    availableGroups = [];
    selectedGroupIds = instance?.selectedGroupIds || [];
    status.textContent = err.message || 'Unable to load groups. Connect the instance first.';
  }
}

// ---------- Messages ----------

function renderMedia(media) {
  if (!media) return '';
  const kind = escapeHtml(media.kind || 'file');
  const label = media.fileName ? `${kind}: ${escapeHtml(media.fileName)}` : kind;

  if (media.url && media.status === 'stored') {
    return `<div style="margin-top:4px;"><a href="${escapeHtml(media.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--wire-500);font-size:12px;">📎 ${label}</a></div>`;
  }
  const why = media.status === 'skipped' ? 'skipped' : 'download failed';
  return `<div class="hint-text" style="margin-top:4px;">📎 ${label} (${why})</div>`;
}

function renderMessages() {
  const tbody = document.getElementById('messages-tbody');
  if (messages.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--ink-muted);padding:32px;">No messages yet — they'll appear here in real time.</td></tr>`;
    return;
  }
  tbody.innerHTML = messages
    .map((m) => {
      const isOut = m.direction === 'out';
      const prefix = m.isLid ? '' : '+';
      const groupLine = m.isGroup
        ? `<div class="hint-text" style="margin-top:2px;">in ${escapeHtml(m.groupName || 'group')}${m.pushName ? ` · ${escapeHtml(m.pushName)}` : ''}</div>`
        : m.pushName
          ? `<div class="hint-text" style="margin-top:2px;">${escapeHtml(m.pushName)}</div>`
          : '';
      return `
      <tr>
        <td style="vertical-align:top;"><span class="mono" style="font-size:12px;">${isOut ? '→' : '←'} ${prefix}${escapeHtml(m.number)}</span>${groupLine}</td>
        <td>${escapeHtml(m.message || '')}${renderMedia(m.media)}</td>
        <td class="hint-text" style="font-size:12px;vertical-align:top;">${new Date(m.waTimestamp || m.timestamp).toLocaleString()}</td>
      </tr>`;
    })
    .join('');
}

async function loadInstance() {
  const data = await api.get(`/instances/${instanceId}`);
  instance = data.instance;
  renderHeader();
  renderQr(null);
  renderProxy();
  renderWebhookForm();
}

async function loadMessages() {
  const data = await api.get(`/instances/${instanceId}/messages`);
  messages = data.messages;
  renderMessages();
}

async function connectInstance() {
  document.getElementById('qr-area').innerHTML = `<div class="spinner"></div>`;
  await api.post(`/instances/${instanceId}/connect`);
}

async function disconnectInstance() {
  if (!confirm('This logs the number out and clears the session. Continue?')) return;
  await api.post(`/instances/${instanceId}/disconnect`);
  await loadInstance();
  await loadGroups();
}

async function deleteInstance() {
  if (!confirm('Permanently delete this instance and its message history?')) return;
  await api.delete(`/instances/${instanceId}`);
  window.location.href = '/';
}

document.getElementById('connect-btn').addEventListener('click', connectInstance);
document.getElementById('disconnect-btn').addEventListener('click', disconnectInstance);
document.getElementById('delete-btn').addEventListener('click', deleteInstance);

document.getElementById('proxy-toggle').addEventListener('change', async (e) => {
  const data = await api.patch(`/instances/${instanceId}/proxy`, { useProxy: e.target.checked });
  instance = data.instance;
  renderProxy();
});

document.getElementById('copy-secret-btn').addEventListener('click', (e) => {
  copyToClipboard(instance.webhookSecret || '', e.currentTarget);
});
document.getElementById('regen-secret-btn').addEventListener('click', async () => {
  const data = await api.patch(`/instances/${instanceId}/webhook`, { regenerateSecret: true });
  instance = data.instance;
  renderWebhookForm();
});

document.getElementById('webhook-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('save-webhook-btn');
  const savedMsg = document.getElementById('webhook-saved-msg');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const data = await api.patch(`/instances/${instanceId}/webhook`, {
      webhookUrl: document.getElementById('webhook-url').value,
      includeGroupMessages: document.getElementById('include-groups').checked,
      includeOwnMessages: document.getElementById('include-own').checked,
    });
    instance = data.instance;
    savedMsg.style.display = 'inline';
    setTimeout(() => (savedMsg.style.display = 'none'), 2000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save webhook';
  }
});

document.getElementById('refresh-groups-btn').addEventListener('click', () => loadGroups({ refresh: true }));
document.getElementById('group-search').addEventListener('input', renderGroups);

document.getElementById('save-groups-btn').addEventListener('click', async () => {
  const status = document.getElementById('groups-status');
  const savedMsg = document.getElementById('groups-saved-msg');
  const btn = document.getElementById('save-groups-btn');

  btn.disabled = true;
  try {
    const data = await api.patch(`/instances/${instanceId}/groups`, { selectedGroupIds });
    selectedGroupIds = data.selectedGroupIds || [];
    instance = { ...instance, selectedGroupIds };
    renderGroups();
    savedMsg.style.display = 'inline';
    setTimeout(() => (savedMsg.style.display = 'none'), 2000);
  } catch (err) {
    status.textContent = err.message || 'Failed to save selected groups.';
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('test-send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById('test-result');
  resultEl.textContent = '';
  try {
    await api.post(`/instances/${instanceId}/send`, {
      to: document.getElementById('test-to').value,
      text: document.getElementById('test-text').value,
    });
    resultEl.textContent = 'Sent ✓';
    document.getElementById('test-text').value = '';
  } catch (err) {
    resultEl.textContent = err.message || 'Failed to send';
  }
});

function setupSocket() {
  const socket = io({ withCredentials: true });
  socket.on('connect', () => socket.emit('join', instanceId));

  socket.on('qr', (payload) => {
    if (payload.instanceId !== instanceId) return;
    renderQr(payload.qr);
  });

  socket.on('status', (payload) => {
    if (payload.instanceId !== instanceId) return;
    instance = { ...instance, ...payload };
    renderHeader();
    if (payload.status === 'connected') {
      renderQr(null);
      loadGroups(); // the group list is only available once connected
    }
  });

  socket.on('message', (payload) => {
    if (payload.instanceId !== instanceId) return;
    messages = [{ ...payload, waTimestamp: payload.timestamp }, ...messages];
    renderMessages();
  });
}

(async function init() {
  const account = await initLayout();
  if (!account) return;
  if (!instanceId) {
    window.location.href = '/';
    return;
  }
  await loadInstance();
  await loadMessages();
  await loadGroups();
  setupSocket();
})();