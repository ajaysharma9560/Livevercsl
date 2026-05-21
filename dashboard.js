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

firebase.initializeApp(firebaseConfig);
const database = firebase.database();

let currentDeviceId = localStorage.getItem('cctv_device_id') || '';
let socket = null;
let frameCount = 0;

const RENDER_SERVER_URL = 'https://server-3-phat.onrender.com';

function connectToStream() {
    if (socket) {
        socket.disconnect();
    }
    
    addLog('🔄 Connecting to Render...');
    
    // Use polling first, then upgrade to websocket
    socket = io(RENDER_SERVER_URL, {
        transports: ['polling', 'websocket'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000
    });
    
    socket.on('connect', () => {
        addLog('✅ Connected to Render');
        socket.emit('register_viewer');
        addLog('👁️ Viewer registered');
    });
    
    socket.on('frame', (data) => {
        frameCount++;
        addLog(`📸 Frame #${frameCount}: ${data.byteLength || data.length} bytes`);
        
        // Convert binary to image
        const blob = new Blob([data], { type: 'image/jpeg' });
        const imageUrl = URL.createObjectURL(blob);
        
        const imgElement = document.getElementById('liveFrame');
        if (imgElement) {
            imgElement.src = imageUrl;
            document.getElementById('streamStatus').innerHTML = `🟢 LIVE (${frameCount} frames received)`;
            document.getElementById('streamStatus').style.color = '#4CAF50';
        }
        
        setTimeout(() => URL.revokeObjectURL(imageUrl), 100);
    });
    
    socket.on('disconnect', () => {
        addLog('⚠️ Disconnected from Render');
        document.getElementById('streamStatus').innerHTML = '⚫ Disconnected';
    });
    
    socket.on('connect_error', (err) => {
        addLog('❌ Connection error: ' + err.message);
    });
}

function sendCommand(command) {
    if (!currentDeviceId) {
        alert('Enter Device ID first!');
        return;
    }
    
    addLog(`📤 Sending: ${command}`);
    
    database.ref(`camera/${currentDeviceId}/command`).set(command)
        .then(() => addLog(`✅ ${command} sent`))
        .catch((error) => addLog(`❌ Error: ${error.message}`));
}

function listenToDeviceStatus() {
    if (!currentDeviceId) return;
    
    database.ref(`camera/${currentDeviceId}`).on('value', (snapshot) => {
        const data = snapshot.val();
        
        if (!data) {
            updateUI('offline');
            return;
        }
        
        updateUI(data.status || 'offline');
        
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

function updateUI(status) {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    
    dot.className = 'status-dot';
    
    switch(status) {
        case 'online':
            dot.classList.add('online');
            text.innerHTML = '🟢 ONLINE - Streaming';
            startBtn.disabled = true;
            stopBtn.disabled = false;
            break;
        case 'ready':
            dot.classList.add('ready');
            text.innerHTML = '🟠 READY - Camera ready';
            startBtn.disabled = false;
            stopBtn.disabled = true;
            break;
        case 'offline':
            dot.classList.add('offline');
            text.innerHTML = '🔴 OFFLINE';
            startBtn.disabled = false;
            stopBtn.disabled = true;
            break;
        default:
            dot.classList.add('offline');
            text.innerHTML = '⚫ UNKNOWN';
    }
}

function saveDeviceId() {
    const newDeviceId = document.getElementById('deviceId').value.trim();
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

function addLog(message) {
    const logContainer = document.getElementById('logContainer');
    if (!logContainer) return;
    
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    const timestamp = new Date().toLocaleTimeString();
    logEntry.innerHTML = `[${timestamp}] ${message}`;
    logContainer.insertBefore(logEntry, logContainer.firstChild);
    
    while (logContainer.children.length > 30) {
        logContainer.removeChild(logContainer.lastChild);
    }
}

// Update FPS counter every second
setInterval(() => {
    if (frameCount > 0) {
        const fpsElement = document.getElementById('fpsCounter');
        if (fpsElement) {
            fpsElement.innerHTML = `${frameCount} FPS`;
        }
        frameCount = 0;
    }
}, 1000);

document.addEventListener('DOMContentLoaded', () => {
    connectToStream();
    loadSavedDeviceId();
    addLog('🚀 Dashboard ready');
    addLog(`🎥 Render: ${RENDER_SERVER_URL}`);
});
