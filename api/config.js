// ✅ REAL BACKEND URL - YAHAN HIDDEN
const BACKEND_URL = "https://7b434949-dbeb-45b7-887f-df55385c7703-00-2yn8zylsn6t5v.sisko.replit.dev";

// ✅ SECRET KEYS - Sirf ye keys kaam karengi
const VALID_KEYS = [
    "ludoo_master_key_2024",
    "ludoo_backup_key_123"
];

export default function handler(req, res) {
    // 🔑 API key check - URL se key lo
    const apiKey = req.query.key;
    
    // ❌ Agar key invalid hai to deny
    if (!apiKey || !VALID_KEYS.includes(apiKey)) {
        return res.status(401).json({ 
            error: "Unauthorized", 
            message: "Invalid or missing API key" 
        });
    }
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    // ✅ Key sahi hai to real URL bhejo
    res.status(200).json({
        success: true,
        backendUrl: BACKEND_URL,
        timestamp: Date.now()
    });
}
