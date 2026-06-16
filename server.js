import express from 'express';
import { readFileSync } from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/config.json', (req, res) => {
    const config = JSON.parse(readFileSync('./config.json', 'utf8'));
    res.json(config);
});

app.get('/', (req, res) => {
    res.send('Ludoo Config Server Running');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
