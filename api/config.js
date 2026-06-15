// api/config.js
export default function handler(req, res) {
    // ✅ APNA REAL BACKEND URL YAHAN DALEIN
    const BACKEND_URL = "https://7b434949-dbeb-45b7-887f-df55385c7703-00-2yn8zylsn6t5v.sisko.replit.dev";
    
    // CORS headers (important for app)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Preflight request handle
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    
    // Response
    res.status(200).json({
        success: true,
        backendUrl: BACKEND_URL,
        version: "1.0",
        timestamp: Date.now(),
        message: "Config server is running"
    });
}
