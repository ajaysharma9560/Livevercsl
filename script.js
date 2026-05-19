// Firebase Config - lucky-a1ffc
const firebaseConfig = {
    apiKey: "AIzaSyDk10orWqWdVcjf-Utivr4pkMaxri_8eao",
    authDomain: "lucky-a1ffc.firebaseapp.com",
    databaseURL: "https://lucky-a1ffc-default-rtdb.firebaseio.com",
    projectId: "lucky-a1ffc",
    storageBucket: "lucky-a1ffc.firebasestorage.app",
    messagingSenderId: "701695529096",
    appId: "1:701695529096:android:d6a44b82a340f329bdcf3d"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const deviceId = "device001";

// DOM elements
const startBtn = document.getElementById('startLiveBtn');
const stopBtn = document.getElementById('stopLiveBtn');
const liveImg = document.getElementById('liveImg');
const noStreamDiv = document.getElementById('noStreamMsg');
const deviceDot = document.getElementById('deviceDot');
const deviceStatusSpan = document.getElementById('deviceStatus');
const cameraDot = document.getElementById('cameraDot');
const cameraStatusSpan = document.getElementById('cameraStatus');
const resBadge = document.getElementById('resBadge');
const lastSeenSpan = document.getElementById('lastSeenTime');
const dataModeSpan = document.getElementById('dataMode');
const streamStateSpan = document.getElementById('streamStateText');

let currentRes = '240p';
let frameInterval = null;

// ========== UI Helpers ==========
function updateDeviceStatus(online, cameraActive) {
    if (online) {
        deviceDot.className = 'dot online';
        deviceStatusSpan.innerText = 'Online';
    } else {
        deviceDot.className = 'dot';
        deviceStatusSpan.innerText = 'Offline';
    }

    if (cameraActive) {
        cameraDot.className = 'dot active';
        cameraStatusSpan.innerText = 'Active';
    } else {
        cameraDot.className = 'dot';
        cameraStatusSpan.innerText = 'Inactive';
    }
}

function updateLastSeen(timestamp) {
    if (timestamp) {
        const d = new Date(timestamp);
        lastSeenSpan.innerText = d.toLocaleTimeString() + ' ' + d.toLocaleDateString();
    }
}

function updateResolutionBadge(res) {
    resBadge.innerText = res;
    if (res === '120p') dataModeSpan.innerText = 'Low (~50MB/h)';
    else if (res === '240p') dataModeSpan.innerText = 'Medium (~240MB/h)';
    else dataModeSpan.innerText = 'High (~720MB/h)';
}

function setStreamActive(active) {
    if (active) {
        streamStateSpan.innerHTML = '🔴 LIVE';
        streamStateSpan.className = 'live-text';
    } else {
        streamStateSpan.innerHTML = '⚪ Idle';
        streamStateSpan.className = 'idle';
    }
}

// ========== Firebase Commands ==========
function sendCommand(path, value) {
    db.ref(path).set(value).catch(err => console.warn(err));
}

// START
startBtn.onclick = () => {
    sendCommand(`commands/${deviceId}/start`, true);
    sendCommand(`commands/${deviceId}/stop`, false);
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStreamActive(false);
    noStreamDiv.classList.remove('hide');
    liveImg.classList.remove('show');
};

// STOP
stopBtn.onclick = () => {
    sendCommand(`commands/${deviceId}/stop`, true);
    sendCommand(`commands/${deviceId}/start`, false);
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStreamActive(false);
    noStreamDiv.classList.remove('hide');
    liveImg.classList.remove('show');
};

// Resolution buttons
document.querySelectorAll('.res-opt').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.res-opt').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const res = btn.getAttribute('data-res');
        currentRes = res;
        updateResolutionBadge(res);
        sendCommand(`commands/${deviceId}/resolution`, res);
    };
});

// Flip camera
document.getElementById('flipCamBtn').onclick = () => {
    sendCommand(`commands/${deviceId}/flip`, true);
};

// ========== Listeners ==========
// Frames (live stream)
db.ref(`frames/${deviceId}`).on('value', (snap) => {
    const frame = snap.val();
    if (frame && frame !== 'null' && frame !== '') {
        liveImg.src = `data:image/jpeg;base64,${frame}`;
        liveImg.classList.add('show');
        noStreamDiv.classList.add('hide');
        setStreamActive(true);
    } else {
        liveImg.classList.remove('show');
        noStreamDiv.classList.remove('hide');
        setStreamActive(false);
    }
});

// Device status (online, cameraActive, lastSeen, resolution)
db.ref(`status/${deviceId}`).on('value', (snap) => {
    const st = snap.val();
    if (st) {
        updateDeviceStatus(st.online === true, st.cameraActive === true);
        updateLastSeen(st.lastSeen);
        if (st.resolution) {
            currentRes = st.resolution;
            updateResolutionBadge(currentRes);
            // sync active resolution button
            document.querySelectorAll('.res-opt').forEach(btn => {
                if (btn.getAttribute('data-res') === currentRes) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
        }
    } else {
        updateDeviceStatus(false, false);
    }
});

// Cleanup on page unload (optional)
window.addEventListener('beforeunload', () => {
    // nothing needed
});

updateResolutionBadge('240p');
