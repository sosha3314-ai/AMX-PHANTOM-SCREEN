const params = new URLSearchParams(location.search);
const room = params.get('room');
const $ = s => document.querySelector(s);
let socket, deviceId, pc, stream, pendingCandidates = [];
const status = (text, error = false) => { $('#shareStatus').textContent = text; $('#shareStatus').style.borderColor = error ? '#743044' : ''; };
function iceServers() { return [{ urls: 'stun:stun.l.google.com:19302' }]; }
function getDeviceId() {
  const key = 'amx-phantom-device-id';
  let id = localStorage.getItem(key);
  if (!id) { id = `dev_${crypto.randomUUID().replaceAll('-', '')}`; localStorage.setItem(key, id); }
  return id;
}
$('#shareForm').addEventListener('submit', e => {
  e.preventDefault();
  if (!room || room.length < 30) return status('کد اتاق نامعتبر یا منقضی شده است. QR تازه‌ای بساز.', true);
  deviceId = getDeviceId();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/signal?room=${encodeURIComponent(room)}`);
  socket.onopen = () => socket.send(JSON.stringify({ type: 'register', deviceId, name: $('#deviceName').value.trim().slice(0, 40) || 'گوشی من' }));
  socket.onmessage = async event => {
    const m = JSON.parse(event.data);
    if (m.type === 'registered') { status('گوشی وصل شد. برای ارسال تصویر، خودت باید اجازه بدهی.'); $('#consentBox').classList.remove('hidden'); }
    if (m.type === 'watch-request') status('داشبورد درخواست نمایش داده است. اگر مایل هستی، «انتخاب صفحه» را بزن.');
    if (m.type === 'answer') {
      if (pc) { await pc.setRemoteDescription(m.answer); for (const c of pendingCandidates) await pc.addIceCandidate(c).catch(()=>{}); pendingCandidates = []; }
    }
    if (m.type === 'ice' && m.candidate && pc) {
      if (pc.remoteDescription) await pc.addIceCandidate(m.candidate).catch(()=>{}); else pendingCandidates.push(m.candidate);
    }
    if (m.type === 'stop') stopShare();
    if (m.type === 'error') status(m.message, true);
  };
  socket.onerror = () => status('اتصال برقرار نشد. اتاق ممکن است منقضی شده باشد.', true);
  socket.onclose = () => status('اتصال قطع شد. QR تازه بساز و دوباره وصل شو.', true);
});
$('#startShareBtn').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) return status('این مرورگر Screen Capture را پشتیبانی نمی‌کند. از مرورگر سازگار و HTTPS استفاده کن.', true);
  try {
    // The browser's native picker and permission prompt are mandatory; never capture without user action.
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    stream.getVideoTracks()[0].addEventListener('ended', stopShare);
    pc = new RTCPeerConnection({ iceServers: iceServers() });
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    pc.onicecandidate = e => { if (e.candidate && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ice', candidate: e.candidate })); };
    pc.onconnectionstatechange = () => status(`وضعیت WebRTC: ${pc.connectionState}`);
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    socket.send(JSON.stringify({ type: 'offer', offer: pc.localDescription }));
    status('درخواست اشتراک‌گذاری ارسال شد. تا پایان، نشانگر ضبط مرورگر را بررسی کن.');
  } catch (err) { status(err.name === 'NotAllowedError' ? 'اجازه داده نشد؛ هیچ تصویری ارسال نشد.' : `شروع اشتراک‌گذاری ناموفق بود: ${err.message}`, true); }
});
function stopShare() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (pc) { pc.close(); pc = null; }
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stream-stopped' }));
  status('اشتراک‌گذاری متوقف شد.');
}
$('#stopShareBtn').addEventListener('click', stopShare);
window.addEventListener('beforeunload', stopShare);
