const $ = (s) => document.querySelector(s);
const fa = (n) => new Intl.NumberFormat('fa-IR').format(n);
let socket;
let peers = new Map();
let currentDevices = [];
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); }
async function api(url, options = {}) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (r.status === 401) { location.href = '/'; throw new Error('ورود لازم است'); }
  const d = await r.json(); if (!r.ok) throw new Error(d.error || 'خطای درخواست'); return d;
}
async function loadRoom() {
  try {
    const d = await api('/api/room'); $('#qrImage').src = d.qr; $('#qrPlaceholder').classList.add('hidden'); $('#shareUrl').value = d.shareUrl;
  } catch (e) { toast(e.message); }
}
async function loadData() {
  try {
    const [s, d] = await Promise.all([api('/api/status'), api('/api/devices')]);
    $('#activeCount').textContent = fa(s.activeCount); $('#registeredCount').textContent = fa(s.registeredCount);
    const secs = s.uptimeSeconds; $('#uptime').textContent = `${fa(Math.floor(secs / 3600))}س ${fa(Math.floor((secs % 3600) / 60))}د`;
    currentDevices = d.devices; renderDevices(d.devices, d.onlineIds); renderHistory(d.events, d.devices);
  } catch (e) { console.error(e); }
}
function renderDevices(devices, onlineIds) {
  const online = new Set(onlineIds); $('#deviceCount').textContent = `${fa(online.size)} دستگاه آنلاین`;
  $('#deviceGrid').innerHTML = '';
  const live = devices.filter(d => online.has(d.id));
  if (!live.length) {
    $('#deviceGrid').innerHTML = '<div class="empty-state"><span>▣</span><b>هنوز دستگاهی متصل نیست</b><p>QR را با گوشی اسکن کن و اشتراک‌گذاری را تأیید کن.</p></div>'; return;
  }
  live.forEach(d => {
    const card = document.createElement('article'); card.className = 'device-card';
    const head = document.createElement('div'); head.className = 'device-head';
    const info = document.createElement('div'); const name = document.createElement('div'); name.className = 'device-name'; name.textContent = d.name;
    const id = document.createElement('div'); id.className = 'device-id'; id.textContent = d.id.slice(0, 16);
    info.append(name, id); const status = document.createElement('span'); status.className = 'online'; status.textContent = '● ONLINE'; head.append(info, status);
    const preview = document.createElement('div'); preview.className = 'preview'; preview.id = `preview-${CSS.escape(d.id)}`; preview.textContent = 'برای درخواست نمایش زنده کلیک کن';
    const actions = document.createElement('div'); actions.className = 'device-actions';
    const watch = document.createElement('button'); watch.className = 'primary'; watch.textContent = 'درخواست نمایش زنده'; watch.addEventListener('click', () => watchDevice(d.id));
    const stop = document.createElement('button'); stop.className = 'ghost'; stop.textContent = 'توقف'; stop.addEventListener('click', () => stopWatching(d.id));
    actions.append(watch, stop); card.append(head, preview, actions); $('#deviceGrid').append(card);
  });
}
function renderHistory(events, devices) {
  const names = new Map(devices.map(d => [d.id, d.name]));
  const tbody = $('#historyBody'); tbody.innerHTML = '';
  if (!events.length) { tbody.innerHTML = '<tr><td colspan="4">هنوز رویدادی ثبت نشده است.</td></tr>'; return; }
  events.forEach(e => {
    const tr = document.createElement('tr');
    [e.device_name || names.get(e.device_id) || '—', e.event_type, new Date(e.created_at).toLocaleString('fa-IR'), (devices.find(d => d.id === e.device_id)?.sessions ?? '—')].forEach(v => { const td = document.createElement('td'); td.textContent = String(v); tr.append(td); });
    tbody.append(tr);
  });
}
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/signal`);
  socket.onmessage = async (event) => {
    const m = JSON.parse(event.data);
    if (m.type === 'status') { currentDevices = m.devices; loadData(); }
    if (m.type === 'offer') await handleOffer(m);
    if (m.type === 'ice') {
      const p = peers.get(m.deviceId); if (p && m.candidate) try { await p.addIceCandidate(m.candidate); } catch (e) { console.warn(e); }
    }
    if (m.type === 'stream-stopped') { const v = document.querySelector(`#preview-${CSS.escape(m.deviceId)} video`); if (v) v.remove(); toast('اشتراک‌گذاری توسط گوشی متوقف شد.'); }
    if (m.type === 'error') toast(m.message);
  };
  socket.onclose = () => setTimeout(connectSocket, 1800);
}
function watchDevice(id) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return toast('اتصال سیگنال هنوز آماده نیست.');
  socket.send(JSON.stringify({ type: 'watch', deviceId: id })); toast('درخواست نمایش ارسال شد؛ صاحب گوشی باید تأیید کند.');
}
function stopWatching(id) {
  const p = peers.get(id); if (p) { p.close(); peers.delete(id); }
  const preview = document.querySelector(`#preview-${CSS.escape(id)}`); if (preview) { preview.innerHTML = ''; preview.textContent = 'نمایش متوقف شد'; }
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop', deviceId: id }));
}
async function handleOffer(m) {
  const pc = new RTCPeerConnection({ iceServers: iceServers() }); peers.set(m.deviceId, pc);
  pc.onicecandidate = e => { if (e.candidate) socket.send(JSON.stringify({ type: 'ice', deviceId: m.deviceId, candidate: e.candidate })); };
  pc.ontrack = e => {
    const preview = document.querySelector(`#preview-${CSS.escape(m.deviceId)}`); if (!preview) return;
    preview.innerHTML = ''; const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true; video.srcObject = e.streams[0]; video.style.cssText = 'width:100%;height:100%;object-fit:contain'; preview.append(video);
  };
  try { await pc.setRemoteDescription(m.offer); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); socket.send(JSON.stringify({ type: 'answer', deviceId: m.deviceId, answer: pc.localDescription })); }
  catch (e) { toast('ساخت اتصال WebRTC ناموفق بود.'); console.error(e); }
}
function iceServers() {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  // For production, inject short-lived TURN configuration through a secured backend endpoint.
  return servers;
}
$('#copyBtn').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#shareUrl').value); toast('لینک کپی شد.'); } catch { $('#shareUrl').select(); toast('لینک را دستی کپی کن.'); } });
$('#newQrBtn').addEventListener('click', async () => { await loadRoom(); toast('لینک اتاق به‌روزرسانی شد.'); });
$('#refreshBtn').addEventListener('click', loadData); $('#historyRefresh').addEventListener('click', loadData);
$('#logoutBtn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/'; });
loadRoom(); loadData(); connectSocket(); setInterval(loadData, 10000);
