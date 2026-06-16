export default function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({
        success: true,
        message: "APK Proxy is working"
    });
}
