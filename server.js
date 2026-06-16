const express = require('express');
const app = express();

// Enable CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// ✅ BACKEND URL - APK_URL ENVIRONMENT VARIABLE SE LEGA
const BACKEND_URL = process.env.APK_URL;

app.get('/api/config', (req, res) => {
    // Check if URL is set
    if (!BACKEND_URL) {
        return res.status(500).json({
            success: false,
            error: "APK_URL environment variable not set"
        });
    }
    
    res.json({
        success: true,
        backendUrl: BACKEND_URL,
        timestamp: Date.now()
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Home page
app.get('/', (req, res) => {
    res.send('Config Server Running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 APK_URL: ${BACKEND_URL ? '✓ Set' : '✗ Not set'}`);
});
