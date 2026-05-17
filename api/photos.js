const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: 'dypwj2dhh',
    api_key: '564619366162332',
    api_secret: 'SOT0Ig91c_ZKU9cZQ4tEYjYDJYs'
});

export default async function handler(req, res) {
    try {
        // Enable CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        const result = await cloudinary.api.resources({
            type: 'upload',
            prefix: 'live_cams',
            resource_type: 'image',
            max_results: 50
        });
        
        res.status(200).json({ 
            success: true, 
            photos: result.resources || [],
            count: result.resources?.length || 0
        });
    } catch (error) {
        console.error('Cloudinary error:', error);
        res.status(500).json({ 
            success: false, 
            photos: [], 
            error: error.message 
        });
    }
}
