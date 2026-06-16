// api/config.js
const BACKEND_URL = process.env.APK_URL;

export default function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    // Validate
    if (!BACKEND_URL) {
        return res.status(500).json({
            success: false,
            error: "APK_URL not configured",
            message: "Please set APK_URL in environment variables"
        });
    }
    
    // Success response
    res.status(200).json({
        success: true,
        backendUrl: BACKEND_URL,
        timestamp: Date.now(),
        source: "environment_variable"
    });
}
