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

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const liveImage = document.getElementById('liveImage');
const placeholder = document.getElementById('placeholder');
const statusText = document.getElementById('statusText');

// START button
startBtn.onclick = () => {
    database.ref('commands').child(deviceId).child('start').set(true);
    database.ref('commands').child(deviceId).child('stop').set(false);
    
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusText.innerHTML = 'Starting...';
};

// STOP button
stopBtn.onclick = () => {
    database.ref('commands').child(deviceId).child('stop').set(true);
    database.ref('commands').child(deviceId).child('start').set(false);
    
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
