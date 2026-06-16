const express = require('express');
const app = express();

// Enable CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    next();
});

const SECRET_KEY = "ludoo_secret_2024";

app.get('/api/config', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    
    if (apiKey !== SECRET_KEY) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    // ✅ SIRF VARIABLE - NO FALLBACK LINK
    const BACKEND_URL = process.env.APK_URL;
    
    if (!BACKEND_URL) {
        return res.status(500).json({ error: "APK_URL not configured" });
    }
    
    res.json({
        success: true,
        backendUrl: BACKEND_URL,
        timestamp: Date.now()
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
    res.send('Config Server Running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});
