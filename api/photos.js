const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: 'dypwj2dhh',
    api_key: '564619366162332',
    api_secret: 'SOT0Ig91c_ZKU9cZQ4tEYjYDJYs'
});

export default async function handler(req, res) {
    try {
        const result = await cloudinary.api.resources({
            type: 'upload',
            prefix: 'live_cams',
            resource_type: 'image',
            max_results: 50
        });
        res.json({ photos: result.resources || [] });
    } catch (err) {
        res.json({ photos: [], error: err.message });
    }
}
