import { db } from "./firebase.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const deviceRef = ref(db, "devices/droid");

onValue(deviceRef, (snapshot) => {
    const data = snapshot.val();

    if (!data) return;

    const lastSeen = data.lastSeen || 0;
    const now = Date.now();

    const isOnline =
        data.status === "online" &&
        (now - lastSeen < 20000);

    document.getElementById("status").innerText =
        isOnline ? "🟢 ONLINE" : "🔴 OFFLINE";
});
