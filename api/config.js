export default function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    // ✅ DIRECT URL - NO ENVIRONMENT VARIABLE
    const BACKEND_URL = "https://7b434949-dbeb-45b7-887f-df55385c7703-00-2yn8zylsn6t5v.sisko.replit.dev";
    
    res.status(200).json({
        success: true,
        backendUrl: BACKEND_URL,
        timestamp: Date.now()
    });
}
