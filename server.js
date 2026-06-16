const express = require('express');
const app = express();

// Enable CORS for Android app
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// ✅ CONFIG ENDPOINT - Android app yahan se URL lega
app.get('/api/config', (req, res) => {
    res.json({
        success: true,
        backendUrl: "https://7b434949-dbeb-45b7-887f-df55385c7703-00-2yn8zylsn6t5v.sisko.replit.dev",
        timestamp: Date.now()
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// Home page
app.get('/', (req, res) => {
    res.send('Config Server Running. Use /api/config endpoint.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Config server running on port ${PORT}`);
    console.log(`📍 API: /api/config`);
});
