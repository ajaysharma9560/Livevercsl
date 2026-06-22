const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling']
});

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

// ========== STATE ==========
let devices = [];
let deviceHeartbeats = {};
let pendingCommands = {};
let latestFrames = {};
let deviceSettings = {};
let activeStreams = {}; // deviceId -> socket.id

function getDeviceSettings(deviceId) {
    if (!deviceSettings[deviceId]) {
        deviceSettings[deviceId] = { stream: false, quality: 240, fps: 15, camera: 'back' };
    }
    return deviceSettings[deviceId];
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

// Cleanup stale devices every 60s
setInterval(() => {
    const now = Date.now();
    devices = devices.filter(device => {
        const stale = (now - (device.lastSeen || 0)) > 300000;
        if (stale) {
            console.log(`🗑️ Removing stale device: ${device.id}`);
            delete deviceHeartbeats[device.id];
            delete pendingCommands[device.id];
            delete latestFrames[device.id];
            delete deviceSettings[device.id];
            delete activeStreams[device.id];
            return false;
        }
        return true;
    });
}, 60000);

// ========== HTTP API ==========

// REGISTER DEVICE
app.post('/api/register', (req, res) => {
    try {
        const { deviceId, deviceName } = req.body;
        console.log(`📱 Device registered: ${deviceId} (${deviceName})`);
        let device = devices.find(d => d.id === deviceId);
        if (!device) {
            device = {
                id: deviceId,
                name: deviceName || 'Android Device',
                connectedAt: new Date().toLocaleTimeString(),
                firstSeen: Date.now()
            };
            devices.push(device);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// HEARTBEAT
app.post('/api/heartbeat', (req, res) => {
    try {
        const {
            deviceId, deviceName, camera, cameraReady, streaming,
            cameraPermission, batteryOptimization, batteryPercentage
        } = req.body;

        deviceHeartbeats[deviceId] = Date.now();
        let device = devices.find(d => d.id === deviceId);
        if (!device) {
            device = {
                id: deviceId,
                name: deviceName || 'Android Device',
                connectedAt: new Date().toLocaleTimeString(),
                firstSeen: Date.now()
            };
            devices.push(device);
        }
        device.name = deviceName || device.name;
        device.camera = camera || device.camera;
        device.cameraReady = cameraReady || false;
        device.streaming = streaming || false;
        device.cameraPermission = cameraPermission || false;
        device.batteryOptimization = batteryOptimization || false;
        device.batteryPercentage = batteryPercentage || 0;
        device.lastHeartbeat = new Date().toLocaleTimeString();
        device.lastSeen = Date.now();
        res.json({ success: true, settings: getDeviceSettings(deviceId) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// FRAME UPLOAD (HTTP fallback)
app.post('/api/frame', (req, res) => {
    try {
        const { deviceId, image, quality, fps, camera } = req.body;
        if (deviceId && image) {
            const ds = getDeviceSettings(deviceId);
            const frameData = {
                image,
                ts: Date.now(),
                quality: quality || ds.quality || 240,
                fps: fps || ds.fps || 15,
                camera: camera || ds.camera || 'back'
            };
            latestFrames[deviceId] = frameData;
            
            // Broadcast via WebSocket if active
            if (activeStreams[deviceId]) {
                io.to(activeStreams[deviceId]).emit('frame', {
                    deviceId,
                    image,
                    timestamp: frameData.ts
                });
            }
            
            const dev = devices.find(d => d.id === deviceId);
            if (dev) dev.lastSeen = Date.now();
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// FRAME FETCH
app.get('/api/frame/:deviceId', (req, res) => {
    const frame = resolveLatestFrame(req.params.deviceId);
    if (!frame) return res.json({ success: false, image: null });
    res.json({ success: true, image: frame.image, ts: frame.ts });
});

// COMMAND SEND (HTTP Only)
app.post('/api/command', (req, res) => {
    try {
        const { deviceId, command, value } = req.body;
        console.log(`📨 HTTP Command: [${command}] for [${deviceId}]`);

        const ds = getDeviceSettings(deviceId);
        switch (command) {
            case 'start':
                ds.stream = true;
                break;
            case 'stop':
                ds.stream = false;
                break;
            case 'flip':
                ds.camera = ds.camera === 'back' ? 'front' : 'back';
                break;
            case 'quality':
                ds.quality = value;
                break;
            case 'fps':
                ds.fps = value;
                break;
        }

        const cmd = { command, value: value ?? null };

        // Queue for HTTP polling
        if (deviceId) {
            if (!pendingCommands[deviceId]) pendingCommands[deviceId] = [];
            pendingCommands[deviceId].push(cmd);
            console.log(`📦 Command queued for HTTP poll: ${command}`);
        }

        res.json({ success: true, settings: getDeviceSettings(deviceId) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// COMMAND POLL (Android - HTTP Only)
app.get('/api/commands/:deviceId', (req, res) => {
    try {
        const { deviceId } = req.params;
        deviceHeartbeats[deviceId] = Date.now();

        if (!findCanonicalDevice(deviceId)) {
            devices.push({
                id: deviceId,
                name: deviceId,
                connectedAt: new Date().toLocaleTimeString(),
                firstSeen: Date.now(),
                lastSeen: Date.now()
            });
        }

        let cmds = [];
        if (pendingCommands[deviceId] && pendingCommands[deviceId].length > 0) {
            cmds = pendingCommands[deviceId].map(c => c.command);
            pendingCommands[deviceId] = [];
        }

        if (cmds.length > 0) {
            console.log(`✅ HTTP Poll delivered ${cmds.length} commands to ${deviceId}`);
        }

        res.json({
            success: true,
            settings: getDeviceSettings(deviceId),
            commands: cmds
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DEVICES LIST
app.get('/api/devices', (req, res) => {
    const now = Date.now();
    res.json({
        success: true,
        devices: devices.map(d => ({
            id: d.id,
            name: d.name,
            camera: d.camera || 'back',
            cameraReady: d.cameraReady || false,
            streaming: d.streaming || false,
            cameraPermission: d.cameraPermission || false,
            batteryOptimization: d.batteryOptimization || false,
            batteryPercentage: d.batteryPercentage || 0,
            isConnected: (now - (d.lastSeen || 0)) < 30000,
            hasWebSocket: !!activeStreams[d.id],
            lastHeartbeat: d.lastHeartbeat,
            connectedAt: d.connectedAt,
            settings: getDeviceSettings(d.id)
        }))
    });
});

// DEVICE DETAIL
app.get('/api/device/:deviceId', (req, res) => {
    const device = devices.find(d => d.id === req.params.deviceId);
    if (!device) return res.status(404).json({ success: false, error: 'Not found' });
    const now = Date.now();
    res.json({
        success: true,
        device: {
            ...device,
            isConnected: (now - (device.lastSeen || 0)) < 30000,
            hasWebSocket: !!activeStreams[device.id],
            settings: getDeviceSettings(device.id)
        }
    });
});

// HEALTH
app.get('/api/health', (req, res) => res.json({
    status: 'ok',
    devices: devices.length,
    uptime: process.uptime(),
    frames: Object.keys(latestFrames).length,
    commands: Object.keys(pendingCommands).reduce((acc, key) => acc + pendingCommands[key].length, 0)
}));

// DEBUG
app.get('/api/debug', (req, res) => {
    res.json({
        devices: devices.map(d => d.id),
        activeStreams,
        pendingCommands,
        heartbeats: Object.fromEntries(
            Object.entries(deviceHeartbeats).map(([k, v]) => [k, `${Math.round((Date.now() - v) / 1000)}s ago`])
        )
    });
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

// ========== WEBSOCKET (Only for Stream) ==========

io.on('connection', (socket) => {
    console.log(`🔌 WS connected: ${socket.id}`);

    // Android registers for WebSocket streaming
    socket.on('register_stream', (data) => {
        const { deviceId, deviceName, cameraReady, cameraPermission, batteryOptimization } = data;

        const canonical = findCanonicalDevice(deviceId);
        const canonicalId = canonical ? canonical.id : deviceId;

        let device = devices.find(d => d.id === canonicalId);
        if (!device) {
            device = {
                id: canonicalId,
                name: deviceName || 'Android Device',
                connectedAt: new Date().toLocaleTimeString(),
                firstSeen: Date.now()
            };
            devices.push(device);
        }
        if (deviceName) device.name = deviceName;
        if (cameraReady !== undefined) device.cameraReady = cameraReady;
        if (cameraPermission !== undefined) device.cameraPermission = cameraPermission;
        if (batteryOptimization !== undefined) device.batteryOptimization = batteryOptimization;
        device.lastHeartbeat = new Date().toLocaleTimeString();
        device.lastSeen = Date.now();

        socket.deviceId = canonicalId;
        socket.join('streamers');

        console.log(`📡 Device [${canonicalId}] registered for WebSocket stream`);
        socket.emit('settings', getDeviceSettings(canonicalId));
    });

    // Status update from Android
    socket.on('device_status_update', (data) => {
        const canonicalId = socket.deviceId;
        if (!canonicalId) return;
        const device = devices.find(d => d.id === canonicalId);
        if (!device) return;

        const { cameraReady, cameraPermission, batteryOptimization, batteryPercentage, streaming } = data;
        if (cameraReady !== undefined) device.cameraReady = cameraReady;
        if (cameraPermission !== undefined) device.cameraPermission = cameraPermission;
        if (batteryOptimization !== undefined) device.batteryOptimization = batteryOptimization;
        if (batteryPercentage !== undefined) device.batteryPercentage = batteryPercentage;
        if (streaming !== undefined) device.streaming = streaming;
        device.lastSeen = Date.now();

        console.log(`🔄 Status update [${canonicalId}]: cam=${cameraPermission} batt=${batteryOptimization}`);
    });

    // Frame via WebSocket (Android sends)
    socket.on('stream_frame', (data) => {
        const { deviceId, image, timestamp, quality, fps, camera } = data;
        const canonicalId = socket.deviceId || deviceId;

        const dev = devices.find(d => d.id === canonicalId);
        if (dev) dev.lastSeen = Date.now();

        if (canonicalId && image) {
            const ds = getDeviceSettings(canonicalId);
            const frameData = {
                image,
                ts: timestamp || Date.now(),
                quality: quality || ds.quality || 240,
                fps: fps || ds.fps || 15,
                camera: camera || ds.camera || 'back'
            };
            latestFrames[canonicalId] = frameData;

            // Add to active stream
            activeStreams[canonicalId] = socket.id;

            // Broadcast to dashboard
            socket.broadcast.emit('frame', {
                deviceId: canonicalId,
                image,
                timestamp: frameData.ts
            });
        }
    });

    // Dashboard subscribes to a device stream
    socket.on('subscribe_stream', (data) => {
        const { deviceId } = data;
        if (deviceId) {
            socket.join(`stream_${deviceId}`);
            console.log(`📺 Dashboard subscribed to ${deviceId}`);
            
            // Send latest frame if available
            const frame = resolveLatestFrame(deviceId);
            if (frame) {
                socket.emit('frame', {
                    deviceId,
                    image: frame.image,
                    timestamp: frame.ts
                });
            }
        }
    });

    socket.on('disconnect', () => {
        if (socket.deviceId) {
            const disconnectedId = socket.deviceId;
            setTimeout(() => {
                if (activeStreams[disconnectedId] === socket.id) {
                    delete activeStreams[disconnectedId];
                    console.log(`📴 Device [${disconnectedId}] WS stream ended`);
                }
            }, 8000);
            console.log(`⚠️ Device [${disconnectedId}] WS drop — waiting 8s`);
        } else {
            console.log(`🔌 WS client disconnected: ${socket.id}`);
        }
    });
});

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
h1{font-size:28px;margin-bottom:4px;color:#fff;}
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
  <div class="lock">🔒</div>
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

// ========== DASHBOARD ==========
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
        .container { max-width:700px; margin:0 auto; }
        .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
        .header h1 { font-size:22px; background:linear-gradient(135deg,#667eea,#764ba2); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
        .logout-btn { background:rgba(255,255,255,0.08); border:1px solid #333; color:#888; padding:6px 14px; border-radius:20px; font-size:12px; cursor:pointer; text-decoration:none; transition:all .2s; }
        .logout-btn:hover { background:rgba(244,67,54,0.2); border-color:#f44336; color:#ff6b6b; }

        .device-selector { display:flex; gap:8px; overflow-x:auto; padding-bottom:12px; margin-bottom:16px; scrollbar-width:none; }
        .device-selector::-webkit-scrollbar { display:none; }
        .device-btn { background:#1a1a1a; border:2px solid #2a2a2a; padding:8px 16px; border-radius:20px; color:#888; font-size:12px; cursor:pointer; white-space:nowrap; transition:all .2s; }
        .device-btn.active { border-color:#667eea; color:#fff; background:rgba(102,126,234,0.15); }
        .device-btn.online { border-color:#4CAF50; }
        .device-btn.offline { border-color:#f44336; opacity:0.5; }
        .device-btn .status-dot { display:inline-block; width:6px; height:6px; border-radius:50%; margin-right:6px; }
        .device-btn.online .status-dot { background:#4CAF50; }
        .device-btn.offline .status-dot { background:#f44336; }

        .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:16px; }
        .stat-card { background:#1a1a1a; border-radius:12px; padding:10px; text-align:center; border:1px solid #2a2a2a; }
        .stat-label { font-size:10px; color:#888; margin-bottom:3px; text-transform:uppercase; letter-spacing:0.5px; }
        .stat-value { font-size:16px; font-weight:700; }
        .stat-value.online { color:#4CAF50; }
        .stat-value.offline { color:#f44336; }
        .stat-value.streaming { color:#4CAF50; }
        .stat-value.stopped { color:#ff9800; }

        .video-container { background:#000; border-radius:16px; overflow:hidden; aspect-ratio:16/9; margin-bottom:16px; border:1px solid #2a2a2a; display:flex; align-items:center; justify-content:center; position:relative; }
        #video { width:100%; height:100%; object-fit:cover; display:none; }
        .video-placeholder { text-align:center; color:#555; padding:20px; }
        .video-placeholder span { font-size:48px; display:block; margin-bottom:8px; }
        .video-placeholder .hint { font-size:12px; color:#444; }
        #streamStatus { position:absolute; top:10px; left:10px; font-size:10px; padding:4px 12px; border-radius:20px; font-weight:600; display:none; }
        .stream-live { background:rgba(76,175,80,.9); color:#fff; display:block !important; }
        .stream-waiting { background:rgba(255,152,0,.9); color:#fff; display:block !important; }
        .stream-noframes{ background:rgba(244,67,54,.9); color:#fff; display:block !important; }

        .controls { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:16px; }
        .ctrl-btn { padding:10px; border:none; border-radius:12px; font-size:12px; font-weight:600; cursor:pointer; transition:all .2s; display:flex; flex-direction:column; align-items:center; gap:3px; }
        .ctrl-btn .icon { font-size:18px; }
        .ctrl-btn:active { transform:scale(0.95); }
        .ctrl-btn.start { background:rgba(76,175,80,0.2); color:#4CAF50; border:1px solid rgba(76,175,80,0.3); }
        .ctrl-btn.start:hover { background:rgba(76,175,80,0.3); }
        .ctrl-btn.start.active { background:#4CAF50; color:#fff; }
        .ctrl-btn.stop { background:rgba(244,67,54,0.2); color:#f44336; border:1px solid rgba(244,67,54,0.3); }
        .ctrl-btn.stop:hover { background:rgba(244,67,54,0.3); }
        .ctrl-btn.stop.active { background:#f44336; color:#fff; }
        .ctrl-btn.flip { background:rgba(33,150,243,0.2); color:#2196F3; border:1px solid rgba(33,150,243,0.3); }
        .ctrl-btn.flip:hover { background:rgba(33,150,243,0.3); }
        .ctrl-btn.settings { background:rgba(255,193,7,0.2); color:#ffc107; border:1px solid rgba(255,193,7,0.3); }
        .ctrl-btn.settings:hover { background:rgba(255,193,7,0.3); }

        .settings-panel { background:#1a1a1a; border-radius:12px; padding:16px; border:1px solid #2a2a2a; display:none; margin-bottom:16px; }
        .settings-panel.show { display:block; }
        .settings-row { display:flex; align-items:center; justify-content:space-between; padding:6px 0; border-bottom:1px solid #222; }
        .settings-row:last-child { border-bottom:none; }
        .settings-label { font-size:13px; color:#aaa; }
        .settings-control { display:flex; gap:8px; align-items:center; }
        .settings-control select, .settings-control input { background:#0a0a0a; border:1px solid #333; color:#fff; padding:4px 10px; border-radius:8px; font-size:12px; outline:none; }
        .settings-control select:focus, .settings-control input:focus { border-color:#667eea; }
        .settings-control button { background:#667eea; border:none; color:#fff; padding:4px 14px; border-radius:8px; font-size:12px; cursor:pointer; }
        .settings-control button:hover { opacity:0.8; }

        .device-list { background:#1a1a1a; border-radius:12px; padding:12px 16px; border:1px solid #2a2a2a; max-height:150px; overflow-y:auto; }
        .device-list::-webkit-scrollbar { width:4px; }
        .device-list::-webkit-scrollbar-track { background:#111; }
        .device-list::-webkit-scrollbar-thumb { background:#333; border-radius:4px; }
        .device-item { display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid #222; font-size:12px; }
        .device-item:last-child { border-bottom:none; }
        .device-item .name { color:#fff; }
        .device-item .status { font-size:10px; padding:2px 10px; border-radius:10px; }
        .device-item .status.online { background:rgba(76,175,80,0.2); color:#4CAF50; }
        .device-item .status.offline { background:rgba(244,67,54,0.2); color:#f44336; }
        .device-item .status.streaming { background:rgba(76,175,80,0.3); color:#4CAF50; }
        .device-item .camera-type { color:#666; font-size:10px; }
        .device-item .battery { color:#ffc107; font-size:10px; }
        .device-item .perms { color:#888; font-size:9px; }

        .no-devices { text-align:center; color:#555; padding:20px; font-size:13px; }
        @media (max-width:500px) { .stats { grid-template-columns:repeat(2,1fr); } .controls { grid-template-columns:repeat(2,1fr); } .header h1 { font-size:18px; } }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>📷 Ludoo Remote</h1>
        <a href="/logout" class="logout-btn">🚪 Logout</a>
    </div>

    <div class="device-selector" id="deviceSelector">
        <button class="device-btn offline" data-id="loading">
            <span class="status-dot"></span> Loading...
        </button>
    </div>

    <div class="stats">
        <div class="stat-card"><div class="stat-label">Status</div><div class="stat-value offline" id="statusVal">● Offline</div></div>
        <div class="stat-card"><div class="stat-label">Stream</div><div class="stat-value stopped" id="streamVal">⏹ Stopped</div></div>
        <div class="stat-card"><div class="stat-label">FPS</div><div class="stat-value" id="fpsVal">0</div></div>
        <div class="stat-card"><div class="stat-label">Quality</div><div class="stat-value" id="qualityVal">240p</div></div>
    </div>

    <div class="video-container">
        <img id="video" src="" alt="Stream">
        <div class="video-placeholder" id="placeholder">
            <span>📹</span>
            <div>No Stream</div>
            <div class="hint">Select a device and click Start</div>
        </div>
        <div id="streamStatus" class="stream-waiting">⏳ Waiting...</div>
    </div>

    <div class="controls">
        <button class="ctrl-btn start" id="btnStart" onclick="sendCommand('start')"><span class="icon">▶️</span> Start</button>
        <button class="ctrl-btn stop" id="btnStop" onclick="sendCommand('stop')"><span class="icon">⏹️</span> Stop</button>
        <button class="ctrl-btn flip" onclick="sendCommand('flip')"><span class="icon">🔄</span> Flip</button>
        <button class="ctrl-btn settings" onclick="toggleSettings()"><span class="icon">⚙️</span> Settings</button>
    </div>

    <div class="settings-panel" id="settingsPanel">
        <div class="settings-row"><span class="settings-label">📐 Quality</span>
            <div class="settings-control">
                <select id="qualitySelect"><option value="120">120p</option><option value="140">140p</option><option value="240" selected>240p</option><option value="360">360p</option></select>
                <button onclick="applySettings()">Apply</button>
            </div>
        </div>
        <div class="settings-row"><span class="settings-label">⚡ FPS</span>
            <div class="settings-control">
                <select id="fpsSelect"><option value="5">5</option><option value="10">10</option><option value="15" selected>15</option><option value="20">20</option><option value="30">30</option></select>
                <button onclick="applySettings()">Apply</button>
            </div>
        </div>
    </div>

    <div class="device-list" id="deviceList"><div class="no-devices">No devices connected</div></div>
</div>

<script>
let currentDeviceId = null;
let devicesData = [];
let streamInterval = null;
let fpsCounter = 0;
let socket = null;

// ========== SOCKET.IO ==========
function connectSocket() {
    socket = io({ transports: ['websocket', 'polling'] });
    
    socket.on('connect', () => {
        console.log('✅ Socket.IO connected');
        // Subscribe to current device stream
        if (currentDeviceId) {
            socket.emit('subscribe_stream', { deviceId: currentDeviceId });
        }
    });
    
    socket.on('frame', (data) => {
        if (data.deviceId === currentDeviceId && data.image) {
            updateFrame('data:image/jpeg;base64,' + data.image);
        }
    });
    
    socket.on('disconnect', () => {
        console.log('❌ Socket.IO disconnected');
    });
}

function updateFrame(src) {
    const video = document.getElementById('video');
    const placeholder = document.getElementById('placeholder');
    const status = document.getElementById('streamStatus');
    
    video.src = src;
    video.style.display = 'block';
    placeholder.style.display = 'none';
    status.className = 'stream-live';
    status.textContent = '🔴 Live';
    fpsCounter++;
}

connectSocket();

// ========== DEVICE FUNCTIONS ==========
function selectDevice(deviceId) {
    currentDeviceId = deviceId;
    document.querySelectorAll('.device-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(\`.device-btn[data-id="\${deviceId}"]\`);
    if (btn) btn.classList.add('active');

    const device = devicesData.find(d => d.id === deviceId);
    if (device) {
        document.getElementById('statusVal').textContent = device.isConnected ? '● Online' : '● Offline';
        document.getElementById('statusVal').className = 'stat-value ' + (device.isConnected ? 'online' : 'offline');
        document.getElementById('streamVal').textContent = device.streaming ? '▶ Streaming' : '⏹ Stopped';
        document.getElementById('streamVal').className = 'stat-value ' + (device.streaming ? 'streaming' : 'stopped');
        document.getElementById('qualityVal').textContent = (device.settings?.quality || 240) + 'p';
    }
    
    // Subscribe to stream via WebSocket
    if (socket && socket.connected) {
        socket.emit('subscribe_stream', { deviceId });
    }
    updateVideoStream();
}

async function loadDevices() {
    try {
        const res = await fetch('/api/devices');
        const data = await res.json();
        if (!data.success) return;
        devicesData = data.devices;

        const selector = document.getElementById('deviceSelector');
        selector.innerHTML = '';
        if (devicesData.length === 0) {
            selector.innerHTML = '<button class="device-btn offline">No devices</button>';
            document.getElementById('deviceList').innerHTML = '<div class="no-devices">No devices connected</div>';
            return;
        }

        devicesData.forEach(d => {
            const btn = document.createElement('button');
            btn.className = 'device-btn ' + (d.isConnected ? 'online' : 'offline');
            btn.dataset.id = d.id;
            btn.innerHTML = \`<span class="status-dot"></span> \${d.name || d.id.slice(0,12)}\`;
            btn.onclick = () => selectDevice(d.id);
            selector.appendChild(btn);
        });

        const list = document.getElementById('deviceList');
        list.innerHTML = devicesData.map(d => \`
            <div class="device-item">
                <span class="name">\${d.name || d.id.slice(0,16)}</span>
                <span class="camera-type">📷 \${d.camera || 'back'}</span>
                <span class="battery">🔋 \${d.batteryPercentage || 0}%</span>
                <span class="perms">📋 \${d.cameraPermission ? '✅' : '❌'} \${d.batteryOptimization ? '⚡' : ''}</span>
                <span class="status \${d.isConnected ? 'online' : 'offline'}">
                    \${d.isConnected ? '● Online' : '○ Offline'}
                    \${d.streaming ? ' 📹' : ''}
                </span>
            </div>
        \`).join('');

        if (devicesData.length > 0 && !currentDeviceId) {
            selectDevice(devicesData[0].id);
        }
    } catch (e) {
        console.error('Load devices error:', e);
    }
}

function updateVideoStream() {
    const video = document.getElementById('video');
    const placeholder = document.getElementById('placeholder');
    const status = document.getElementById('streamStatus');

    if (!currentDeviceId) {
        video.style.display = 'none';
        placeholder.style.display = 'block';
        status.className = 'stream-waiting';
        status.textContent = '⏳ No device selected';
        return;
    }

    const device = devicesData.find(d => d.id === currentDeviceId);
    if (!device || !device.streaming) {
        video.style.display = 'none';
        placeholder.style.display = 'block';
        status.className = 'stream-waiting';
        status.textContent = '⏳ Stream stopped';
        if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
        return;
    }

    video.style.display = 'block';
    placeholder.style.display = 'none';
    status.className = 'stream-live';
    status.textContent = '🔴 Live';

    if (streamInterval) clearInterval(streamInterval);
    streamInterval = setInterval(() => {
        const img = document.getElementById('video');
        img.src = '/api/frame/' + currentDeviceId + '?t=' + Date.now();
        fpsCounter++;
    }, 100);
}

async function sendCommand(command) {
    if (!currentDeviceId) {
        alert('Please select a device first');
        return;
    }
    try {
        const res = await fetch('/api/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: currentDeviceId, command })
        });
        const data = await res.json();
        if (data.success) {
            console.log('✅ Command sent:', command);
            await loadDevices();
            if (command === 'start' || command === 'stop') updateVideoStream();
        }
    } catch (e) {
        console.error('Command error:', e);
    }
}

function toggleSettings() {
    document.getElementById('settingsPanel').classList.toggle('show');
}

async function applySettings() {
    if (!currentDeviceId) return;
    const quality = parseInt(document.getElementById('qualitySelect').value);
    const fps = parseInt(document.getElementById('fpsSelect').value);
    try {
        await fetch('/api/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: currentDeviceId, command: 'quality', value: quality })
        });
        await fetch('/api/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: currentDeviceId, command: 'fps', value: fps })
        });
        document.getElementById('qualityVal').textContent = quality + 'p';
        alert('✅ Settings applied!');
    } catch (e) {
        alert('❌ Failed to apply settings');
    }
}

setInterval(() => {
    document.getElementById('fpsVal').textContent = fpsCounter;
    fpsCounter = 0;
}, 1000);

setInterval(loadDevices, 5000);
loadDevices();
</script>
</body>
</html>`);
});

// ========== START ==========
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('✅  Ludoo Camera Remote  —  Server Ready');
    console.log('═══════════════════════════════════════════════════');
    console.log(`🌐  Web UI       : http://localhost:${PORT}`);
    console.log(`🔑  Password     : ${DASHBOARD_PASSWORD}`);
    console.log('📡  Commands     : HTTP Polling Only');
    console.log('⚡  WebSocket    : Stream Only (Active on "start")');
    console.log('❤️  Heartbeat    : POST /api/heartbeat');
    console.log('📡  HTTP Command : POST /api/command');
    console.log('⏳  HTTP Poll    : GET  /api/commands/:deviceId');
    console.log('🖼️  Frame        : POST/GET /api/frame');
    console.log('📱  Devices      : GET  /api/devices');
    console.log('═══════════════════════════════════════════════════');
    console.log('');
});
