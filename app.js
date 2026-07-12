let myId = null;
let cfg = null;
let myPos = { x: 0, y: 0, z: 0, dimension: 'overworld' };
const peerPositions = new Map();
const connections = new Map(); // id -> { pc, gainNode }
let localStream = null;
let micActive = false;

const talkBtn = document.getElementById('talk');
const mcStatusEl = document.getElementById('mc-status');
const posEl = document.getElementById('pos');
const peersEl = document.getElementById('peers');
const meterBar = document.getElementById('meter-bar');

async function init() {
  const who = await (await fetch('/whoami')).json();
  myId = who.id;
  cfg = who.config;

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  localStream.getAudioTracks().forEach(t => t.enabled = false);
  startMicMeter(localStream);

  // push-to-talk: удержание кнопки (тач + мышь для теста в десктоп-браузере)
  const start = (e) => { e.preventDefault(); setMic(true); };
  const stop = (e) => { e.preventDefault(); setMic(false); };
  talkBtn.addEventListener('touchstart', start, { passive: false });
  talkBtn.addEventListener('touchend', stop);
  talkBtn.addEventListener('touchcancel', stop);
  talkBtn.addEventListener('mousedown', start);
  talkBtn.addEventListener('mouseup', stop);
  talkBtn.addEventListener('mouseleave', stop);

  pollPeers();
  pollInbox();
  setInterval(updateVolumes, 300);
}

function setMic(active) {
  micActive = active;
  localStream.getAudioTracks().forEach(t => t.enabled = active);
  talkBtn.classList.toggle('active', active);
  talkBtn.textContent = active ? '🎙 Говорю...' : 'Удерживай, чтобы говорить';
}

async function pollPeers() {
  try {
    const peers = await (await fetch('/peers')).json();
    renderPeerList(peers);
    const currentIds = new Set(peers.map(p => p.id));

    for (const id of connections.keys()) {
      if (!currentIds.has(id)) closeConnection(id);
    }
    for (const peer of peers) {
      if (connections.has(peer.id)) continue;
      createConnection(peer.id, myId < peer.id);
    }
  } catch {}
  setTimeout(pollPeers, 2000);
}

async function pollInbox() {
  try {
    const events = await (await fetch('/inbox')).json();
    for (const ev of events) await handleEvent(ev);
  } catch {}
  setTimeout(pollInbox, 600);
}

async function handleEvent(ev) {
  if (ev.kind === 'mc-status') {
    mcStatusEl.textContent = ev.connected ? 'подключен ✅' : 'не подключен ❌';
  } else if (ev.kind === 'self-position') {
    myPos = ev;
    posEl.textContent = `${ev.x.toFixed(0)}, ${ev.y.toFixed(0)}, ${ev.z.toFixed(0)} (${ev.dimension})`;
  } else if (ev.kind === 'position') {
    peerPositions.set(ev.from, { x: ev.x, y: ev.y, z: ev.z, dimension: ev.dimension });
  } else if (ev.kind === 'signal') {
    let entry = connections.get(ev.from);
    if (!entry) entry = createConnection(ev.from, false);
    const pc = entry.pc;
    if (ev.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(ev.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(ev.from, { type: 'answer', sdp: pc.localDescription });
    } else if (ev.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(ev.sdp));
    } else if (ev.type === 'candidate' && ev.candidate) {
      try { await pc.addIceCandidate(ev.candidate); } catch {}
    }
  }
}

function sendSignal(to, payload) {
  fetch('/send-signal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, ...payload })
  }).catch(() => {});
}

function createConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(peerId, { type: 'candidate', candidate: e.candidate });
  };

  const audioCtx = window.__audioCtx || (window.__audioCtx = new AudioContext());
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = 0;
  gainNode.connect(audioCtx.destination);

  pc.ontrack = (e) => {
    const source = audioCtx.createMediaStreamSource(e.streams[0]);
    source.connect(gainNode);
  };

  const entry = { pc, gainNode };
  connections.set(peerId, entry);

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(peerId, { type: 'offer', sdp: pc.localDescription });
    };
  }
  return entry;
}

function closeConnection(peerId) {
  const entry = connections.get(peerId);
  if (!entry) return;
  entry.pc.close();
  connections.delete(peerId);
  peerPositions.delete(peerId);
}

function updateVolumes() {
  for (const [id, entry] of connections) {
    const pos = peerPositions.get(id);
    if (!pos || pos.dimension !== myPos.dimension) { entry.gainNode.gain.value = 0; continue; }
    const dx = pos.x - myPos.x, dy = pos.y - myPos.y, dz = pos.z - myPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let vol;
    if (dist <= cfg.fullVolumeDistance) vol = 1;
    else if (dist >= cfg.maxHearDistance) vol = 0;
    else vol = 1 - (dist - cfg.fullVolumeDistance) / (cfg.maxHearDistance - cfg.fullVolumeDistance);
    entry.gainNode.gain.value = vol;
  }
}

function startMicMeter(stream) {
  const audioCtx = window.__audioCtx || (window.__audioCtx = new AudioContext());
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    analyser.getByteTimeDomainData(data);
    let sumSq = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sumSq += v * v; }
    const rms = Math.sqrt(sumSq / data.length);
    const pct = Math.min(100, Math.round(rms * 100 * 3.5));
    meterBar.style.width = (micActive ? pct : 0) + '%';
    requestAnimationFrame(tick);
  }
  tick();
}

function renderPeerList(peers) {
  peersEl.innerHTML = '<small>Игроки рядом:</small>' + peers.map(p =>
    `<div class="peer"><span>${p.username}</span><span>${connections.has(p.id) ? '🔊' : '…'}</span></div>`
  ).join('');
}

init();
