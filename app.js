import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyCcstwitNGxv5osXZ9AQ0a0PDn7j-MTv-0",
  authDomain: "hiddencam-62e2d.firebaseapp.com",
  databaseURL: "https://hiddencam-62e2d-default-rtdb.firebaseio.com",
  projectId: "hiddencam-62e2d",
  storageBucket: "hiddencam-62e2d.firebasestorage.app",
  messagingSenderId: "931792860891",
  appId: "1:931792860891:android:602d1099f876f4688d7efe"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// device node (same as Android)
const deviceRef = ref(db, "devices/droid");

onValue(deviceRef, (snap) => {
    const data = snap.val();

    const statusEl = document.getElementById("status");

    if (!data) {
        statusEl.innerText = "🔴 OFFLINE";
        return;
    }

    const lastSeen = data.lastSeen || 0;
    const now = Date.now();

    const online =
        data.status === "online" &&
        (now - lastSeen < 20000);

    if (online) {
        statusEl.innerText = "🟢 LIVE";
        statusEl.style.color = "#00ff88";
    } else {
        statusEl.innerText = "🔴 OFFLINE";
        statusEl.style.color = "#ff4444";
    }
});
