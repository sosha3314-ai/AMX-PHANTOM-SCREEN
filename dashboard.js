
'use strict';

const $ = (selector) => document.querySelector(selector);
const fa = (n) => new Intl.NumberFormat('fa-IR').format(n);

let socket = null;
let currentDevices = [];
let iceConfig = null;
let icePromise = null;
let reconnectTimer = null;
let activeDeviceId = null;

const peers = new Map();
const pendingCandidates = new Map();
const previewStreams = new Map();
const watchedDevices = new Set();

function toast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (response.status === 401) {
    location.href = '/';
    throw new Error('نشست ورود منقضی شده است.');
  }

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'خطای درخواست');
  return data;
}

async function loadIceServers() {
  if (iceConfig) return iceConfig;
  if (icePromise) return icePromise;

  icePromise = (async () => {
    const response = await fetch('/api/ice-servers', {
      cache: 'no-store',
      credentials: 'same-origin'
    });

    if (response.status === 401) {
      location.href = '/';
      throw new Error('نشست ورود منقضی شده است.');
    }

    if (!response.ok) {
      throw new Error('دریافت تنظیمات STUN/TURN ناموفق بود.');
    }

    const data = await response.json();

    if (!Array.isArray(data.iceServers) || !data.iceServers.length) {
      throw new Error('تنظیمات ICE معتبر نیست.');
    }

    iceConfig = data.iceServers;
    return iceConfig;
  })();

  try {
    return await icePromise;
  } catch (error) {
    icePromise = null;
    throw error;
  }
}

function sendSignal(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

async function loadRoom() {
  try {
    const data = await api('/api/room');
    if ($('#qrImage')) $('#qrImage').src = data.qr;
    $('#qrPlaceholder')?.classList.add('hidden');
    if ($('#shareUrl')) $('#shareUrl').value = data.shareUrl;
  } catch (error) {
    toast(error.message);
  }
}

async function loadData() {
  try {
    const [status, data] = await Promise.all([
      api('/api/status'),
      api('/api/devices')
    ]);

    if ($('#activeCount')) {
      $('#activeCount').textContent = fa(status.activeCount || 0);
    }

    if ($('#registeredCount')) {
      $('#registeredCount').textContent = fa(status.registeredCount || 0);
    }

    const seconds = status.uptimeSeconds || 0;

    if ($('#uptime')) {
      $('#uptime').textContent =
        `${fa(Math.floor(seconds / 3600))}س ` +
        `${fa(Math.floor((seconds % 3600) / 60))}د`;
    }

    currentDevices = data.devices || [];
    renderDevices(currentDevices, data.onlineIds || []);
    renderHistory(data.events || [], currentDevices);
  } catch (error) {
    console.error('Dashboard data error:', error);
  }
}

function renderDevices(devices, onlineIds) {
  const online = new Set(onlineIds);
  const grid = $('#deviceGrid');
  if (!grid) return;

  const liveDevices = devices.filter(device => online.has(device.id));

  if ($('#deviceCount')) {
    $('#deviceCount').textContent = `${fa(online.size)} دستگاه آنلاین`;
  }

  if (!liveDevices.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <span>▣</span>
        <b>هنوز دستگاهی متصل نیست</b>
        <p>QR را با گوشی اسکن کن و اتصال را تأیید کن.</p>
      </div>
    `;
    return;
  }

  const existing = new Map(
    [...grid.querySelectorAll('.device-card')].map(card => [
      card.dataset.deviceId,
      card
    ])
  );

  for (const device of liveDevices) {
    let card = existing.get(device.id);

    if (!card) {
      card = document.createElement('article');
      card.className = 'device-card';
      card.dataset.deviceId = device.id;

      const head = document.createElement('div');
      head.className = 'device-head';

      const info = document.createElement('div');

      const name = document.createElement('div');
      name.className = 'device-name';
      name.textContent = device.name || 'گوشی';

      const id = document.createElement('div');
      id.className = 'device-id';
      id.textContent = device.id.slice(0, 16);

      info.append(name, id);

      const onlineLabel = document.createElement('span');
      onlineLabel.className = 'online';
      onlineLabel.textContent = '● ONLINE';

      head.append(info, onlineLabel);

      const preview = document.createElement('div');
      preview.className = 'preview';
      preview.id = `preview-${device.id}`;
      preview.textContent = 'برای مشاهده تصویر کلیک کن';

      const actions = document.createElement('div');
      actions.className = 'device-actions';

      const watch = document.createElement('button');
      watch.className = 'primary';
      watch.textContent = 'مشاهده صفحه گوشی';
      watch.addEventListener('click', () => watchDevice(device.id));

      const stop = document.createElement('button');
      stop.className = 'ghost';
      stop.textContent = 'توقف';
      stop.addEventListener('click', () => stopWatching(device.id));

      actions.append(watch, stop);
      card.append(head, preview, actions);
    } else {
      const name = card.querySelector('.device-name');
      if (name) name.textContent = device.name || 'گوشی';
    }

    grid.append(card);
    existing.delete(device.id);

    const preview = document.getElementById(`preview-${device.id}`);
    const savedStream = previewStreams.get(device.id);

    if (preview && savedStream && !preview.querySelector('video')) {
      attachPreview(device.id, savedStream);
    }
  }

  for (const [deviceId, card] of existing) {
    if (activeDeviceId === deviceId) stopWatching(deviceId);
    card.remove();
  }
}

function renderHistory(events, devices) {
  const tbody = $('#historyBody');
  if (!tbody) return;

  const names = new Map(devices.map(device => [device.id, device.name]));
  tbody.innerHTML = '';

  if (!events.length) {
    tbody.innerHTML =
      '<tr><td colspan="4">هنوز رویدادی ثبت نشده است.</td></tr>';
    return;
  }

  events.forEach(event => {
    const row = document.createElement('tr');

    const values = [
      event.device_name || names.get(event.device_id) || '—',
      event.event_type || '—',
      new Date(event.created_at).toLocaleString('fa-IR'),
      devices.find(device => device.id === event.device_id)?.sessions ?? '—'
    ];

    values.forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      row.append(cell);
    });

    tbody.append(row);
  });
}

function attachPreview(deviceId, stream) {
  const preview = document.getElementById(`preview-${deviceId}`);
  if (!preview) return;

  let video = preview.querySelector('video');

  if (!video) {
    preview.innerHTML = '';
    video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.style.cssText =
      'width:100%;height:100%;object-fit:contain;background:#000';
    preview.append(video);
  }

  if (video.srcObject !== stream) video.srcObject = stream;

  video.play().catch(error => {
    console.warn('Video autoplay:', error);
  });
}

function closePeer(deviceId, viewerId) {
  const key = `${deviceId}:${viewerId}`;
  const pc = peers.get(key);

  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;

    try { pc.close(); } catch (error) {
      console.warn(error);
    }

    peers.delete(key);
  }

  pendingCandidates.delete(key);
}

function closeDevicePeers(deviceId) {
  for (const [key] of [...peers.entries()]) {
    if (key.startsWith(`${deviceId}:`)) {
      const viewerId = key.slice(deviceId.length + 1);
      closePeer(deviceId, viewerId);
    }
  }

  previewStreams.delete(deviceId);

  const preview = document.getElementById(`preview-${deviceId}`);
  if (preview) {
    preview.innerHTML = '';
    preview.textContent = 'اشتراک‌گذاری متوقف شد';
  }
}

function watchDevice(deviceId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    toast('اتصال داشبورد آماده نیست.');
    return;
  }

  if (activeDeviceId && activeDeviceId !== deviceId) {
    toast('ابتدا نمایش دستگاه قبلی را متوقف کن.');
    return;
  }

  activeDeviceId = deviceId;
  watchedDevices.clear();
  watchedDevices.add(deviceId);

  if (sendSignal({ type: 'watch', deviceId })) {
    toast('درخواست ارسال شد؛ تأیید اشتراک‌گذاری را روی گوشی انجام بده.');
  }
}

function stopWatching(deviceId) {
  watchedDevices.delete(deviceId);

  for (const [key] of [...peers.entries()]) {
    if (key.startsWith(`${deviceId}:`)) {
      const viewerId = key.slice(deviceId.length + 1);
      closePeer(deviceId, viewerId);
    }
  }

  previewStreams.delete(deviceId);

  const preview = document.getElementById(`preview-${deviceId}`);
  if (preview) {
    preview.innerHTML = '';
    preview.textContent = 'نمایش متوقف شد';
  }

  sendSignal({ type: 'stop', deviceId });

  if (activeDeviceId === deviceId) activeDeviceId = null;

  toast('نمایش متوقف شد.');
}

async function handleOffer(message) {
  const { deviceId, viewerId, offer } = message;

  if (!deviceId || !viewerId || !offer) return;

  if (activeDeviceId !== deviceId || !watchedDevices.has(deviceId)) {
    return;
  }

  const key = `${deviceId}:${viewerId}`;

  closePeer(deviceId, viewerId);

  // صف جدید را فقط در صورت نبودن صف قبلی ایجاد می‌کنیم.
  if (!pendingCandidates.has(key)) {
    pendingCandidates.set(key, []);
  }

  let pc = null;

  try {
    const servers = await loadIceServers();

    if (activeDeviceId !== deviceId) return;

    pc = new RTCPeerConnection({ iceServers: servers });
    peers.set(key, pc);

    pc.onicecandidate = event => {
      if (event.candidate) {
        sendSignal({
          type: 'ice',
          deviceId,
          viewerId,
          candidate: event.candidate
        });
      }
    };

    pc.ontrack = event => {
      if (peers.get(key) !== pc) return;

      const receivedStream = event.streams[0];
      if (!receivedStream) return;

      previewStreams.set(deviceId, receivedStream);
      attachPreview(deviceId, receivedStream);
    };

    pc.onconnectionstatechange = () => {
      if (peers.get(key) !== pc) return;

      if (pc.connectionState === 'connected') {
        toast('تصویر گوشی متصل شد.');
      } else if (pc.connectionState === 'failed') {
        toast('اتصال ناموفق بود؛ تنظیمات TURN را بررسی کن.');
      } else if (pc.connectionState === 'disconnected') {
        toast('ارتباط موقتاً قطع شد.');
      }
    };

    await pc.setRemoteDescription(offer);

    if (peers.get(key) !== pc) return;

    const queued = pendingCandidates.get(key) || [];

    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn('Queued ICE error:', error);
      }
    }

    pendingCandidates.set(key, []);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    if (peers.get(key) !== pc) return;

    sendSignal({
      type: 'answer',
      deviceId,
      viewerId,
      answer: pc.localDescription
    });
  } catch (error) {
    console.error('WebRTC offer error:', error);

    if (!pc || peers.get(key) === pc) {
      closePeer(deviceId, viewerId);
    }

    toast('ساخت اتصال WebRTC ناموفق بود.');
  }
}

async function handleIce(message) {
  const { deviceId, viewerId, candidate } = message;
  if (!deviceId || !viewerId || !candidate) return;

  const key = `${deviceId}:${viewerId}`;
  const pc = peers.get(key);

  if (!pc || !pc.remoteDescription) {
    const queue = pendingCandidates.get(key) || [];
    queue.push(candidate);
    pendingCandidates.set(key, queue);
    return;
  }

  try {
    await pc.addIceCandidate(candidate);
  } catch (error) {
    console.warn('ICE candidate error:', error);
  }
}

function handleSocketMessage(message) {
  switch (message.type) {
    case 'status':
      loadData();
      break;

    case 'offer':
      handleOffer(message);
      break;

    case 'ice':
      handleIce(message);
      break;

    case 'stream-stopped':
      if (message.deviceId) {
        closeDevicePeers(message.deviceId);
        if (activeDeviceId === message.deviceId) activeDeviceId = null;
      }
      toast('اشتراک‌گذاری گوشی متوقف شد.');
      break;

    case 'error':
      toast(message.message || 'خطای ارتباط');
      break;
  }
}

function connectSocket() {
  if (socket && (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  )) return;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/signal`);

  socket.onopen = () => {
    toast('اتصال داشبورد برقرار شد.');

    if (activeDeviceId) {
      watchedDevices.add(activeDeviceId);
      sendSignal({ type: 'watch', deviceId: activeDeviceId });
    }
  };

  socket.onmessage = event => {
    try {
      handleSocketMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('Invalid socket message:', error);
    }
  };

  socket.onerror = error => {
    console.warn('WebSocket error:', error);
  };

  socket.onclose = () => {
    for (const [key] of [...peers.entries()]) {
      const split = key.indexOf(':');
      closePeer(key.slice(0, split), key.slice(split + 1));
    }

    previewStreams.clear();

    if (reconnectTimer) clearTimeout(reconnectTimer);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSocket();
    }, 2000);
  };
}

$('#copyBtn')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#shareUrl').value);
    toast('لینک کپی شد.');
  } catch {
    $('#shareUrl').select();
    toast('لینک را دستی کپی کن.');
  }
});

$('#newQrBtn')?.addEventListener('click', async () => {
  await loadRoom();
  toast('QR جدید ساخته شد.');
});

$('#refreshBtn')?.addEventListener('click', loadData);
$('#historyRefresh')?.addEventListener('click', loadData);

$('#logoutBtn')?.addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
    location.href = '/';
  } catch (error) {
    toast(error.message);
  }
});

loadRoom();
loadData();
connectSocket();
setInterval(loadData, 10000);