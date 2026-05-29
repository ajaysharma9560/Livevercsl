import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

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
export const db = getDatabase(app);
