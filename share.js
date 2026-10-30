'use strict';

const params = new URLSearchParams(location.search);
const room = params.get('room');
const $ = selector => document.querySelector(selector);

let socket = null;
let deviceId = null;
let stream = null;
let iceConfig = null;
let stopping = false;
let reconnectTimer = null;
let manuallyDisconnected = false;
let reconnectAttempts = 0;

let activeViewerId = null;
let peer = null;

const pendingViewers = new Set();
const pendingCandidates = [];

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
    {
      cache: 'no-store',
      credentials: 'same-origin'
    }
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
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;

  socket.send(JSON.stringify(data));
  return true;
}

function closePeer() {
  if (peer) {
    peer.onicecandidate = null;
    peer.onconnectionstatechange = null;

    try {
      peer.close();
    } catch (error) {
      console.warn(error);
    }

    peer = null;
  }

  activeViewerId = null;
  pendingCandidates.length = 0;
}

function closeAllPeers(preservePending = false) {
  const previousViewer = activeViewerId;

  closePeer();

  if (!preservePending) {
    pendingViewers.clear();
  } else if (previousViewer) {
    pendingViewers.add(previousViewer);
  }
}

async function createViewerConnection(viewerId) {
  if (!viewerId || !stream) return;

  // فقط یک بیننده مجاز است.
  if (activeViewerId && activeViewerId !== viewerId) {
    sendSocket({
      type: 'error',
      message: 'این گوشی فقط از یک بیننده پشتیبانی می‌کند.'
    });
    return;
  }

  if (peer && activeViewerId === viewerId) return;

  activeViewerId = viewerId;
  pendingViewers.add(viewerId);

  let pc = null;

  try {
    const servers = await loadIceServers();

    if (!stream || activeViewerId !== viewerId) return;

    pc = new RTCPeerConnection({ iceServers: servers });
    peer = pc;

    stream.getTracks().forEach(track => {
      pc.addTrack(track, stream);
    });

    pc.onicecandidate = event => {
      if (!event.candidate || peer !== pc) return;

      sendSocket({
        type: 'ice',
        viewerId,
        candidate: event.candidate
      });
    };

    pc.onconnectionstatechange = () => {
      if (peer !== pc) return;

      if (pc.connectionState === 'connected') {
        status('تصویر گوشی با موفقیت به لپ‌تاپ ارسال شد.');
      } else if (pc.connectionState === 'failed') {
        status('اتصال ناموفق بود. تنظیمات TURN را بررسی کن.', true);
      } else if (pc.connectionState === 'disconnected') {
        status('ارتباط با لپ‌تاپ موقتاً قطع شده است.');
      }
    };

    const offer = await pc.createOffer();

    if (peer !== pc || !stream) return;

    await pc.setLocalDescription(offer);

    if (peer !== pc) return;

    const sent = sendSocket({
      type: 'offer',
      viewerId,
      offer: pc.localDescription
    });

    if (!sent) {
      closePeer();
      status('ارسال درخواست اتصال ناموفق بود.', true);
      return;
    }

    status('درخواست اتصال تصویر ارسال شد.');
  } catch (error) {
    console.error('WebRTC error:', error);

    if (!pc || peer === pc) closePeer();

    status(`ساخت اتصال ناموفق بود: ${error.message}`, true);
  }
}

async function handleAnswer(message) {
  if (!peer || !message.answer) return;

  if (message.viewerId && message.viewerId !== activeViewerId) return;

  const pc = peer;

  try {
    await pc.setRemoteDescription(message.answer);

    if (peer !== pc) return;

    while (pendingCandidates.length) {
      const candidate = pendingCandidates.shift();

      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn('Queued ICE error:', error);
      }
    }
  } catch (error) {
    console.error(error);
    status('دریافت پاسخ اتصال ناموفق بود.', true);
  }
}

async function handleIce(message) {
  if (!message.candidate) return;

  if (
    message.viewerId &&
    activeViewerId &&
    message.viewerId !== activeViewerId
  ) return;

  if (!peer || !peer.remoteDescription) {
    pendingCandidates.push(message.candidate);
    return;
  }

  try {
    await peer.addIceCandidate(message.candidate);
  } catch (error) {
    console.warn('ICE error:', error);
  }
}

function stopShare(notifyServer = true) {
  if (stopping) return;

  stopping = true;

  closeAllPeers(true);

  if (stream) {
    const oldStream = stream;
    stream = null;

    oldStream.getTracks().forEach(track => {
      try {
        track.stop();
      } catch (error) {
        console.warn(error);
      }
    });
  }

  if (notifyServer) {
    sendSocket({ type: 'stream-stopped' });
  }

  stopping = false;
  status('اشتراک‌گذاری متوقف شد.');
}

function handleSocketMessage(message) {
  switch (message.type) {
    case 'registered':
      reconnectAttempts = 0;
      status('گوشی متصل شد. برای شروع، دکمه فعال‌سازی را بزن.');
      $('#consentBox')?.classList.remove('hidden');
      break;

    case 'watch-request':
      if (!message.viewerId) break;

      if (activeViewerId && activeViewerId !== message.viewerId) {
        break;
      }

      activeViewerId = message.viewerId;
      pendingViewers.add(message.viewerId);

      status('درخواست نمایش از لپ‌تاپ دریافت شد.');

      if (stream) {
        createViewerConnection(message.viewerId);
      }

      break;

    case 'answer':
      handleAnswer(message);
      break;

    case 'ice':
      handleIce(message);
      break;

    case 'stop':
      if (
        !message.viewerId ||
        message.viewerId === activeViewerId
      ) {
        closePeer();
        status('نمایش توسط لپ‌تاپ متوقف شد.');
      }
      break;

    case 'stream-stopped':
      stopShare(false);
      break;

    case 'consent':
      status('درخواست نمایش دریافت شد. اجازه اشتراک‌گذاری را تأیید کن.');
      break;

    case 'consent-denied':
      status('اجازه نمایش داده نشد.', true);
      break;

    case 'error':
      status(message.message || 'خطای ارتباط.', true);
      break;
  }
}

function connectPhone() {
  if (!room || room.length < 30) {
    status('کد اتاق نامعتبر است. از داشبورد QR جدید بگیر.', true);
    return;
  }

  if (socket && (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  )) return;

  deviceId = getDeviceId();
  manuallyDisconnected = false;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

  socket = new WebSocket(
    `${protocol}//${location.host}/signal?room=${encodeURIComponent(room)}`
  );

  socket.onopen = () => {
    sendSocket({
      type: 'register',
      deviceId,
      name: $('#deviceName')?.value.trim().slice(0, 40) || 'گوشی من'
    });
  };

  socket.onmessage = event => {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    handleSocketMessage(message);
  };

  socket.onerror = error => {
    console.warn('Socket error:', error);
    status('اتصال برقرار نشد. اینترنت و QR را بررسی کن.', true);
  };

  socket.onclose = event => {
    closeAllPeers(true);

    if (stream) {
      const oldStream = stream;
      stream = null;

      oldStream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch {}
      });
    }

    if (manuallyDisconnected) return;

    // 4001 یعنی اتصال قبلی همین دستگاه جایگزین شده است.
    if (event.code === 4001) {
      status('این گوشی از یک اتصال دیگر جایگزین شده است.', true);
      return;
    }

    reconnectAttempts++;

    if (reconnectAttempts > 3) {
      status('اتصال برقرار نماند. QR تازه بساز و دوباره اسکن کن.', true);
      return;
    }

    status('ارتباط قطع شد؛ تلاش برای اتصال مجدد...');

    clearTimeout(reconnectTimer);

    reconnectTimer = setTimeout(() => {
      if (!manuallyDisconnected) connectPhone();
    }, 2500);
  };
}

async function startShare() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    status('ابتدا گوشی را به سامانه متصل کن.', true);
    return;
  }

  if (stream) {
    status('اشتراک‌گذاری از قبل فعال است.');
    return;
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    status(
      'این مرورگر اشتراک‌گذاری صفحه را پشتیبانی نمی‌کند. از مرورگر سازگار و HTTPS استفاده کن.',
      true
    );
    return;
  }

  try {
    status('پنجره انتخاب صفحه باز می‌شود...');

    // انتخاب صفحه فقط با اقدام و تأیید خود کاربر انجام می‌شود.
    const selectedStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false
    });

    if (socket.readyState !== WebSocket.OPEN) {
      selectedStream.getTracks().forEach(track => track.stop());
      status('اتصال گوشی قطع شده است؛ دوباره QR را اسکن کن.', true);
      return;
    }

    stream = selectedStream;

    const videoTrack = stream.getVideoTracks()[0];

    if (!videoTrack) {
      stopShare(false);
      status('صفحه‌ای انتخاب نشد.', true);
      return;
    }

    videoTrack.addEventListener('ended', () => {
      stopShare(true);
    });

    status('صفحه انتخاب شد. در حال آماده‌سازی اتصال...');

    await loadIceServers();

    const viewers = [...pendingViewers];

    if (!viewers.length) {
      status('اشتراک‌گذاری آماده است؛ منتظر درخواست لپ‌تاپ هستیم.');
      return;
    }

    await createViewerConnection(viewers[0]);
  } catch (error) {
    console.error(error);

    stopShare(false);

    if (error.name === 'NotAllowedError') {
      status('اجازه اشتراک‌گذاری داده نشد.', true);
    } else {
      status(`شروع اشتراک‌گذاری ناموفق بود: ${error.message}`, true);
    }
  }
}

$('#shareForm')?.addEventListener('submit', event => {
  event.preventDefault();

  if (socket && (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  )) {
    status('اتصال گوشی در حال انجام است.');
    return;
  }

  clearTimeout(reconnectTimer);
  connectPhone();
});

$('#startShareBtn')?.addEventListener('click', startShare);

$('#stopShareBtn')?.addEventListener('click', () => {
  stopShare(true);
});

window.addEventListener('beforeunload', () => {
  manuallyDisconnected = true;
  clearTimeout(reconnectTimer);

  if (stream) {
    sendSocket({ type: 'stream-stopped' });

    stream.getTracks().forEach(track => {
      try {
        track.stop();
      } catch {}
    });
  }

  closeAllPeers();

  if (socket) {
    try {
      socket.close();
    } catch {}
  }

  stream = null;
});