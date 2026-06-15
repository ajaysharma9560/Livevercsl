export default function handler(req, res) {
    // Allow CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    
    // Your real backend URL
    const BACKEND_URL = "https://7b434949-dbeb-45b7-887f-df55385c7703-00-2yn8zylsn6t5v.sisko.replit.dev";
    
    // Send response
    res.status(200).json({
        backendUrl: BACKEND_URL,
        success: true
    });
}
