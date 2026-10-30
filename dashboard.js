

'use strict';

const $ = (selector) => document.querySelector(selector);
const fa = (n) => new Intl.NumberFormat('fa-IR').format(n);

let socket = null;
let currentDevices = [];
let iceConfig = null;
let icePromise = null;
let reconnectTimer = null;

const peers = new Map();
const pendingCandidates = new Map();
const watchedDevices = new Set();

function peerKey(deviceId, viewerId) {
  return `${deviceId}:${viewerId}`;
}

function toast(message) {
  const el = $('#toast');
  if (!el) return;

  el.textContent = message;
  el.classList.add('show');

  setTimeout(() => {
    el.classList.remove('show');
  }, 2600);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (response.status === 401) {
    location.href = '/';
    throw new Error('ورود لازم است');
  }

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'خطای درخواست');
  }

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
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  socket.send(JSON.stringify(message));
  return true;
}

async function loadRoom() {
  try {
    const data = await api('/api/room');

    $('#qrImage').src = data.qr;
    $('#qrPlaceholder').classList.add('hidden');
    $('#shareUrl').value = data.shareUrl;
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

    $('#activeCount').textContent = fa(status.activeCount);
    $('#registeredCount').textContent = fa(status.registeredCount);

    const seconds = status.uptimeSeconds;

    $('#uptime').textContent =
      `${fa(Math.floor(seconds / 3600))}س ` +
      `${fa(Math.floor((seconds % 3600) / 60))}د`;

    currentDevices = data.devices || [];

    renderDevices(data.devices || [], data.onlineIds || []);
    renderHistory(data.events || [], data.devices || []);

  } catch (error) {
    console.error('Dashboard data error:', error);
  }
}

function renderDevices(devices, onlineIds) {
  const online = new Set(onlineIds);

  $('#deviceCount').textContent =
    `${fa(online.size)} دستگاه آنلاین`;

  $('#deviceGrid').innerHTML = '';

  const liveDevices = devices.filter(device =>
    online.has(device.id)
  );

  if (!liveDevices.length) {
    $('#deviceGrid').innerHTML = `
      <div class="empty-state">
        <span>▣</span>
        <b>هنوز دستگاهی متصل نیست</b>
        <p>QR را با گوشی اسکن کن و اتصال را تأیید کن.</p>
      </div>
    `;
    return;
  }

  liveDevices.forEach(device => {
    const card = document.createElement('article');
    card.className = 'device-card';

    const head = document.createElement('div');
    head.className = 'device-head';

    const info = document.createElement('div');

    const name = document.createElement('div');
    name.className = 'device-name';
    name.textContent = device.name;

    const id = document.createElement('div');
    id.className = 'device-id';
    id.textContent = device.id.slice(0, 16);

    info.append(name, id);

    const status = document.createElement('span');
    status.className = 'online';
    status.textContent = '● ONLINE';

    head.append(info, status);

    const preview = document.createElement('div');
    preview.className = 'preview';
    preview.id = `preview-${device.id}`;
    preview.textContent = 'برای درخواست نمایش زنده کلیک کن';

    const actions = document.createElement('div');
    actions.className = 'device-actions';

    const watch = document.createElement('button');
    watch.className = 'primary';
    watch.textContent = 'درخواست نمایش زنده';
    watch.addEventListener('click', () => {
      watchDevice(device.id);
    });

    const stop = document.createElement('button');
    stop.className = 'ghost';
    stop.textContent = 'توقف';
    stop.addEventListener('click', () => {
      stopWatching(device.id);
    });

    actions.append(watch, stop);
    card.append(head, preview, actions);

    $('#deviceGrid').append(card);
  });
}

function renderHistory(events, devices) {
  const names = new Map(
    devices.map(device => [device.id, device.name])
  );

  const tbody = $('#historyBody');
  tbody.innerHTML = '';

  if (!events.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4">هنوز رویدادی ثبت نشده است.</td>
      </tr>
    `;
    return;
  }

  events.forEach(event => {
    const row = document.createElement('tr');

    const values = [
      event.device_name || names.get(event.device_id) || '—',
      event.event_type,
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

function closePeer(deviceId, viewerId) {
  const key = peerKey(deviceId, viewerId);
  const pc = peers.get(key);

  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;

    try {
      pc.close();
    } catch (error) {
      console.warn(error);
    }

    peers.delete(key);
  }

  pendingCandidates.delete(key);
}

function closeDevicePeers(deviceId) {
  for (const [key, pc] of [...peers.entries()]) {
    if (key.startsWith(`${deviceId}:`)) {
      closePeerFromKey(key, pc);
    }
  }

  const preview = document.getElementById(`preview-${deviceId}`);

  if (preview) {
    preview.innerHTML = '';
    preview.textContent = 'اشتراک‌گذاری متوقف شد';
  }
}

function closePeerFromKey(key, pc) {
  pc.onicecandidate = null;
  pc.ontrack = null;
  pc.onconnectionstatechange = null;

  try {
    pc.close();
  } catch (error) {
    console.warn(error);
  }

  peers.delete(key);
  pendingCandidates.delete(key);
}

function watchDevice(deviceId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    toast('اتصال سیگنال هنوز آماده نیست.');
    return;
  }

  watchedDevices.add(deviceId);

  const sent = sendSignal({
    type: 'watch',
    deviceId
  });

  if (sent) {
    toast('درخواست نمایش ارسال شد؛ صاحب گوشی باید انتخاب صفحه را تأیید کند.');
  }
}

function stopWatching(deviceId) {
  watchedDevices.delete(deviceId);

  for (const key of [...peers.keys()]) {
    if (key.startsWith(`${deviceId}:`)) {
      const pc = peers.get(key);
      closePeerFromKey(key, pc);
    }
  }

  const preview = document.getElementById(`preview-${deviceId}`);

  if (preview) {
    preview.innerHTML = '';
    preview.textContent = 'نمایش متوقف شد';
  }

  sendSignal({
    type: 'stop',
    deviceId
  });

  toast('درخواست توقف ارسال شد.');
}

async function handleOffer(message) {
  const deviceId = message.deviceId;
  const viewerId = message.viewerId;

  if (!deviceId || !viewerId || !message.offer) {
    console.warn('Offer ناقص دریافت شد:', message);
    return;
  }

  const key = peerKey(deviceId, viewerId);

  closePeer(deviceId, viewerId);

  try {
    const servers = await loadIceServers();

    const pc = new RTCPeerConnection({
      iceServers: servers
    });

    peers.set(key, pc);
    pendingCandidates.set(key, []);

    pc.onicecandidate = event => {
      if (!event.candidate) return;

      sendSignal({
        type: 'ice',
        deviceId,
        viewerId,
        candidate: event.candidate
      });
    };

    pc.ontrack = event => {
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
          'width:100%;height:100%;object-fit:contain';

        preview.append(video);
      }

      video.srcObject = event.streams[0];

      video.play().catch(error => {
        console.warn('Video autoplay:', error);
      });
    };

    pc.onconnectionstatechange = () => {
      if (!peers.has(key)) return;

      if (pc.connectionState === 'connected') {
        toast('اتصال نمایش زنده برقرار شد.');
      }

      if (pc.connectionState === 'failed') {
        toast('اتصال WebRTC ناموفق بود؛ تنظیمات TURN را بررسی کن.');
      }

      if (pc.connectionState === 'disconnected') {
        toast('ارتباط نمایش زنده موقتاً قطع شد.');
      }
    };

    await pc.setRemoteDescription(message.offer);

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

    sendSignal({
      type: 'answer',
      deviceId,
      viewerId,
      answer: pc.localDescription
    });

  } catch (error) {
    console.error('WebRTC offer error:', error);

    closePeer(deviceId, viewerId);

    toast('ساخت اتصال WebRTC ناموفق بود.');
  }
}

async function handleIce(message) {
  const { deviceId, viewerId, candidate } = message;

  if (!deviceId || !viewerId || !candidate) return;

  const key = peerKey(deviceId, viewerId);
  const pc = peers.get(key);

  if (!pc) return;

  try {
    if (pc.remoteDescription) {
      await pc.addIceCandidate(candidate);
    } else {
      const queue = pendingCandidates.get(key) || [];
      queue.push(candidate);
      pendingCandidates.set(key, queue);
    }
  } catch (error) {
    console.warn('ICE candidate error:', error);
  }
}

function handleSocketMessage(message) {
  if (message.type === 'status') {
    currentDevices = message.devices || [];
    loadData();
    return;
  }

  if (message.type === 'offer') {
    handleOffer(message);
    return;
  }

  if (message.type === 'ice') {
    handleIce(message);
    return;
  }

  if (message.type === 'stream-stopped') {
    if (message.deviceId) {
      closeDevicePeers(message.deviceId);
    }

    toast('اشتراک‌گذاری توسط گوشی متوقف شد.');
    return;
  }

  if (message.type === 'error') {
    toast(message.message || 'خطای ارتباط');
  }
}

function connectSocket() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
     socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const protocol =
    location.protocol === 'https:' ? 'wss:' : 'ws:';

  socket = new WebSocket(
    `${protocol}//${location.host}/signal`
  );

  socket.onopen = () => {
    toast('اتصال زنده داشبورد برقرار شد.');

    // بازگرداندن درخواست‌های فعال پس از اتصال مجدد
    for (const deviceId of watchedDevices) {
      sendSignal({
        type: 'watch',
        deviceId
      });
    }
  };

  socket.onmessage = event => {
    try {
      const message = JSON.parse(event.data);
      handleSocketMessage(message);
    } catch (error) {
      console.error('Invalid socket message:', error);
    }
  };

  socket.onerror = error => {
    console.warn('WebSocket error:', error);
  };

  socket.onclose = () => {
    for (const [key, pc] of [...peers.entries()]) {
      closePeerFromKey(key, pc);
    }

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSocket();
    }, 1800);
  };
}

// کپی لینک
$('#copyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#shareUrl').value);
    toast('لینک کپی شد.');
  } catch {
    $('#shareUrl').select();
    toast('لینک را دستی کپی کن.');
  }
});

// ساخت QR جدید
$('#newQrBtn').addEventListener('click', async () => {
  await loadRoom();
  toast('لینک اتاق به‌روزرسانی شد.');
});

// تازه‌سازی اطلاعات
$('#refreshBtn').addEventListener('click', loadData);
$('#historyRefresh').addEventListener('click', loadData);

// خروج
$('#logoutBtn').addEventListener('click', async () => {
  try {
    await api('/api/logout', {
      method: 'POST'
    });

    location.href = '/';
  } catch (error) {
    toast(error.message);
  }
});

// شروع داشبورد
loadRoom();
loadData();
connectSocket();

setInterval(loadData, 10000);
