// Firebase Config for lucky-a1ffc
const firebaseConfig = {
    apiKey: "AIzaSyDk10orWqWdVcjf-Utivr4pkMaxri_8eao",
    authDomain: "lucky-a1ffc.firebaseapp.com",
    databaseURL: "https://lucky-a1ffc-default-rtdb.firebaseio.com",
    projectId: "lucky-a1ffc",
    storageBucket: "lucky-a1ffc.firebasestorage.app",
    messagingSenderId: "701695529096",
    appId: "1:701695529096:android:d6a44b82a340f329bdcf3d"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

const deviceId = "device001";
let currentResolution = "240p";

// DOM Elements
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const liveImage = document.getElementById('liveImage');
const placeholder = document.getElementById('placeholder');
const onlineDot = document.getElementById('onlineDot');
const onlineText = document.getElementById('onlineText');
const resolutionBadge = document.getElementById('resolutionBadge');
const lastSeenSpan = document.getElementById('lastSeen');
const dataModeSpan = document.getElementById('dataMode');

// Resolution buttons
const res120Btn = document.getElementById('res120p');
const res240Btn = document.getElementById('res240p');
const res360Btn = document.getElementById('res360p');
const flipBtn = document.getElementById('flipBtn');

// START button
startBtn.onclick = () => {
    database.ref('commands').child(deviceId).child('start').set(true);
    database.ref('commands').child(deviceId).child('stop').set(false);
    
    startBtn.disabled = true;
    stopBtn.disabled = false;
};

// STOP button
stopBtn.onclick = () => {
    database.ref('commands').child(deviceId).child('stop').set(true);
    database.ref('commands').child(deviceId).child('start').set(false);
    
    startBtn.disabled = false;
    stopBtn.disabled = true;
    liveImage.style.display = 'none';
    liveImage.classList.remove('active');
    placeholder.classList.remove('hidden');
};

// Resolution selection
res120Btn.onclick = () => setResolution("120p");
res240Btn.onclick = () => setResolution("240p");
res360Btn.onclick = () => setResolution("360p");

function setResolution(res) {
    currentResolution = res;
    
    // Update UI
    [res120Btn, res240Btn, res360Btn].forEach(btn => btn.classList.remove('active'));
    if (res === "120p") res120Btn.classList.add('active');
    if (res === "240p") res240Btn.classList.add('active');
    if (res === "360p") res360Btn.classList.add('active');
    
    resolutionBadge.textContent = res;
    
    // Update data mode display
    if (res === "120p") dataModeSpan.textContent = "Low (Saves Data)";
    if (res === "240p") dataModeSpan.textContent = "Medium";
    if (res === "360p") dataModeSpan.textContent = "High (More Data)";
    
    // Send resolution command to Android
    database.ref('commands').child(deviceId).child('resolution').setValue(res);
}

// Flip camera
flipBtn.onclick = () => {
    database.ref('commands').child(deviceId).child('flip').setValue(true);
    flipBtn.style.opacity = "0.5";
    setTimeout(() => { flipBtn.style.opacity = "1"; }, 500);
};

// Listen for frames
database.ref('frames').child(deviceId).on('value', (snapshot) => {
    const frame = snapshot.val();
    
    if (frame) {
        liveImage.src = "data:image/jpeg;base64," + frame;
        liveImage.style.display = 'block';
        liveImage.classList.add('active');
        placeholder.classList.add('hidden');
    }
});

// Listen for device status
database.ref('status').child(deviceId).on('value', (snapshot) => {
    const status = snapshot.val();
    
    if (status) {
        if (status.online) {
            onlineDot.className = 'dot online';
            onlineText.textContent = 'Online';
        } else {
            onlineDot.className = 'dot offline';
            onlineText.textContent = 'Offline';
        }
        
        if (status.lastSeen) {
            const date = new Date(status.lastSeen);
            lastSeenSpan.textContent = date.toLocaleTimeString();
        }
        
        if (status.resolution) {
            resolutionBadge.textContent = status.resolution;
        }
    }
});

// Connection status
database.ref('.info/connected').on('value', (snapshot) => {
    if (snapshot.val() === true) {
        console.log("Connected to Firebase");
    }
});

// Set default resolution on load
setResolution("240p");    database.ref('commands').child(deviceId).child('start').set(false);
    
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statusText.innerHTML = 'Offline';
    statusText.className = 'offline';
    liveImage.style.display = 'none';
    liveImage.classList.remove('active');
    placeholder.classList.remove('hidden');
};

// Listen for frames
database.ref('frames').child(deviceId).on('value', (snapshot) => {
    const frame = snapshot.val();
    
    if (frame) {
        liveImage.src = "data:image/jpeg;base64," + frame;
        liveImage.style.display = 'block';
        liveImage.classList.add('active');
        placeholder.classList.add('hidden');
        statusText.innerHTML = '🔴 LIVE';
        statusText.className = 'online';
    }
});

// Connection status
database.ref('.info/connected').on('value', (snapshot) => {
    if (snapshot.val() === true) {
        statusText.innerHTML = 'Connected';
    } else {
        statusText.innerHTML = 'Disconnected';
        statusText.className = 'offline';
    }
});
