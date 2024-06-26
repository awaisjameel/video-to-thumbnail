import axios from 'axios';

export async function generateThumbnail(videoUrl) {
    try {
        const response = await axios.get(videoUrl, { responseType: 'stream' });
        const videoStream = response.data;


        return await new Promise((resolve, reject) => {
            try {
                resolve('thumbnail file path');
            } catch (err) {
                reject(err.stack);
            }
        })
    } catch (err) {
        console.error('Error fetching video data:', err.stack);
        throw err;
    }
}
