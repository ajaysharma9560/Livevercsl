// ✅ REAL BACKEND URL - YAHAN HIDDEN HAI (API ke andar)
const BACKEND_URL = "https://7b434949-dbeb-45b7-887f-df55385c7703-00-2yn8zylsn6t5v.sisko.replit.dev";

export default function handler(req, res) {
    // Optional: API key check for extra security
    const apiKey = req.query.key;
    const validKey = "your-secret-key-123";  // 🔒 API key bhi add kar sakte ho
    
    // Agar API key check karna hai to (optional)
    // if (apiKey !== validKey) {
    //     return res.status(401).json({ error: "Unauthorized" });
    // }
    
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Response - Real URL yahan se bhejo
    res.status(200).json({
        backendUrl: BACKEND_URL,
        success: true
    });
}
