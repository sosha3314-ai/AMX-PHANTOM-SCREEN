
'use strict';

const params = new URLSearchParams(location.search);
const room = params.get('room');
const $ = selector => document.querySelector(selector);

let socket = null;
let deviceId = null;
let stream = null;
let iceConfig = null;
let stopping = false;

const peers = new Map();
const pendingViewers = new Set();
const pendingCandidates = new Map();

function status(message, error = false) {
  const el = $('#shareStatus');
  if (!el) return;

  el.textContent = message;
  el.style.borderColor = error ? '#743044' : '';
}

function getDeviceId() {
  const key = 'amx-phantom-device-id';
  let id = localStorage.getItem(key);

  if (!id) {
    id = `dev_${crypto.randomUUID().replaceAll('-', '')}`;
    localStorage.setItem(key, id);
  }

  return id;
}

async function loadIceServers() {
  if (iceConfig) return iceConfig;

  const response = await fetch(
    `/api/ice-servers?room=${encodeURIComponent(room)}`,
    { cache: 'no-store' }
  );

  if (!response.ok) {
    throw new Error('دریافت تنظیمات WebRTC ناموفق بود.');
  }

  const data = await response.json();

  if (!Array.isArray(data.iceServers) || !data.iceServers.length) {
    throw new Error('تنظیمات ICE معتبر نیست.');
  }

  iceConfig = data.iceServers;
  return iceConfig;
}

function sendSocket(data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  socket.send(JSON.stringify(data));
  return true;
}

function closeViewer(viewerId) {
  const pc = peers.get(viewerId);

  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;

    try {
      pc.close();
    } catch {}

    peers.delete(viewerId);
  }

  pendingCandidates.delete(viewerId);
  pendingViewers.delete(viewerId);
}

function closeAllPeers() {
  for (const viewerId of [...peers.keys()]) {
    closeViewer(viewerId);
  }

  pendingViewers.clear();
}

async function createViewerConnection(viewerId) {
  if (!viewerId || peers.has(viewerId)) return;

  if (!stream) {
    pendingViewers.add(viewerId);
    status('درخواست نمایش دریافت شد. برای شروع، انتخاب صفحه را بزن.');
    return;
  }

  try {
    const servers = await loadIceServers();

    if (!stream || !pendingViewers.has(viewerId)) return;

    const pc = new RTCPeerConnection({
      iceServers: servers
    });

    peers.set(viewerId, pc);
    pendingCandidates.set(viewerId, []);

    stream.getTracks().forEach(track => {
      pc.addTrack(track, stream);
    });

    pc.onicecandidate = event => {
      if (event.candidate) {
        sendSocket({
          type: 'ice',
          viewerId,
          candidate: event.candidate
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (!peers.has(viewerId)) return;

      if (pc.connectionState === 'connected') {
        status('اتصال نمایش زنده برقرار شد.');
      } else if (pc.connectionState === 'failed') {
        status('اتصال ناموفق بود. تنظیمات TURN را بررسی کن.', true);
      } else if (pc.connectionState === 'disconnected') {
        status('ارتباط با یکی از بیننده‌ها قطع شده است.');
      }
    };

    const offer = await pc.createOffer();

    if (!peers.has(viewerId)) return;

    await pc.setLocalDescription(offer);

    sendSocket({
      type: 'offer',
      viewerId,
      offer: pc.localDescription
    });

    status('درخواست اتصال تصویر ارسال شد.');

  } catch (error) {
    console.error(error);
    closeViewer(viewerId);
    status(`ساخت اتصال ناموفق بود: ${error.message}`, true);
  }
}

async function handleAnswer(message) {
  const viewerId = message.viewerId;
  const pc = peers.get(viewerId);

  if (!pc || !message.answer) return;

  try {
    await pc.setRemoteDescription(message.answer);

    const candidates = pendingCandidates.get(viewerId) || [];

    for (const candidate of candidates) {
      await pc.addIceCandidate(candidate).catch(console.warn);
    }

    pendingCandidates.set(viewerId, []);

  } catch (error) {
    console.error(error);
    status('دریافت پاسخ اتصال ناموفق بود.', true);
  }
}

async function handleIce(message) {
  const viewerId = message.viewerId;
  const pc = peers.get(viewerId);

  if (!pc || !message.candidate) return;

  try {
    if (pc.remoteDescription) {
      await pc.addIceCandidate(message.candidate);
    } else {
      const candidates = pendingCandidates.get(viewerId) || [];
      candidates.push(message.candidate);
      pendingCandidates.set(viewerId, candidates);
    }
  } catch (error) {
    console.warn('ICE error:', error);
  }
}

function connectPhone() {
  if (!room || room.length < 30) {
    status('کد اتاق نامعتبر یا منقضی شده است. QR تازه بساز.', true);
    return;
  }

  deviceId = getDeviceId();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

  socket = new WebSocket(
    `${protocol}//${location.host}/signal?room=${encodeURIComponent(room)}`
  );

  socket.onopen = () => {
    sendSocket({
      type: 'register',
      deviceId,
      name: $('#deviceName').value.trim().slice(0, 40) || 'گوشی من'
    });
  };

  socket.onmessage = async event => {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (message.type) {
      case 'registered':
        status('گوشی متصل شد. برای ارسال تصویر باید خودت اجازه بدهی.');
        $('#consentBox').classList.remove('hidden');
        break;

      case 'watch-request':
        if (!message.viewerId) break;

        pendingViewers.add(message.viewerId);

        status('داشبورد درخواست نمایش زنده داده است.');

        if (stream) {
          await createViewerConnection(message.viewerId);
        }
        break;

      case 'answer':
        await handleAnswer(message);
        break;

      case 'ice':
        await handleIce(message);
        break;

      case 'stop':
        if (message.viewerId) {
          closeViewer(message.viewerId);
          status('نمایش برای یکی از بیننده‌ها متوقف شد.');
        }
        break;

      case 'stream-stopped':
        stopShare(false);
        status('اشتراک‌گذاری متوقف شد.');
        break;

      case 'consent':
        status('درخواست نمایش دریافت شد. انتخاب صفحه با اجازه خودت انجام می‌شود.');
        break;

      case 'consent-denied':
        status('اجازه نمایش داده نشد.', true);
        break;

      case 'error':
        status(message.message || 'خطای ارتباط.', true);
        break;
    }
  };

  socket.onerror = () => {
    status('اتصال برقرار نشد. اینترنت و QR را بررسی کن.', true);
  };

  socket.onclose = () => {
    closeAllPeers();
    status('اتصال گوشی قطع شد. دوباره QR را اسکن کن.', true);
  };
}

async function startShare() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    status('ابتدا گوشی را به سامانه متصل کن.', true);
    return;
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    status('این مرورگر Screen Capture را پشتیبانی نمی‌کند. از مرورگر سازگار و HTTPS استفاده کن.', true);
    return;
  }

  if (stream) {
    status('اشتراک‌گذاری از قبل فعال است.');
    return;
  }

  try {
    // انتخاب صفحه فقط با اقدام و اجازه صریح صاحب گوشی
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false
    });

    const videoTrack = stream.getVideoTracks()[0];

    if (!videoTrack) {
      stopShare(false);
      status('تصویری انتخاب نشد.', true);
      return;
    }

    videoTrack.addEventListener('ended', () => {
      stopShare(true);
    });

    status('صفحه انتخاب شد. در حال آماده‌سازی اتصال...');

    await loadIceServers();

    const viewers = [...pendingViewers];

    if (!viewers.length) {
      status('اشتراک‌گذاری آماده است. منتظر درخواست داشبورد هستیم.');
      return;
    }

    for (const viewerId of viewers) {
      await createViewerConnection(viewerId);
    }

    status('اشتراک‌گذاری فعال است.');

  } catch (error) {
    console.error(error);

    stopShare(false);

    if (error.name === 'NotAllowedError') {
      status('اجازه داده نشد؛ هیچ تصویری ارسال نشد.', true);
    } else {
      status(`شروع اشتراک‌گذاری ناموفق بود: ${error.message}`, true);
    }
  }
}

function stopShare(notifyServer = true) {
  if (stopping) return;

  stopping = true;

  closeAllPeers();

  if (stream) {
    const oldStream = stream;
    stream = null;

    oldStream.getTracks().forEach(track => {
      try {
        track.stop();
      } catch {}
    });
  }

  if (notifyServer) {
    sendSocket({
      type: 'stream-stopped'
    });
  }

  stopping = false;
  status('اشتراک‌گذاری متوقف شد.');
}

// اتصال گوشی
$('#shareForm').addEventListener('submit', event => {
  event.preventDefault();

  if (socket && socket.readyState === WebSocket.OPEN) {
    status('گوشی از قبل متصل است.');
    return;
  }

  connectPhone();
});

// شروع اشتراک‌گذاری
$('#startShareBtn').addEventListener('click', startShare);

// توقف اشتراک‌گذاری
$('#stopShareBtn').addEventListener('click', () => {
  stopShare(true);
});

// خروج از صفحه
window.addEventListener('beforeunload', () => {
  if (stream) {
    sendSocket({ type: 'stream-stopped' });

    stream.getTracks().forEach(track => {
      track.stop();
    });
  }

  closeAllPeers();
  stream = null;
});