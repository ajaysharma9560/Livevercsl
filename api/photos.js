const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: 'dypwj2dhh',
    api_key: '564619366162332',
    api_secret: 'SOT0Ig91c_ZKU9cZQ4tEYjYDJYs'
});

export default async function handler(req, res) {
    try {
        // 🔥 CHANGE: resource_type se 'video' fetch karo
        const result = await cloudinary.api.resources({
            type: 'upload',
            prefix: 'live_cams',
            resource_type: 'video',     // 🔥 YEH CHANGE KARO (pehle image tha)
            max_results: 20
        });
        
        const videos = result.resources.map(video => ({
            url: video.secure_url,
            created_at: video.created_at,
            public_id: video.public_id
        }));
        
        res.json({ success: true, videos: videos.reverse() });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
}
