import express from "express";
import handler from "./api/apk.js";

const app = express();
const PORT = 5000;

app.get("/api/apk", handler);

app.get("/", (req, res) => {
  res.send("APK Proxy Server is running. Use GET /api/apk to download.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
