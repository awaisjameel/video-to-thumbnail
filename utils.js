import axios from 'axios';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { promisify } from 'util';

const writeFileAsync = promisify(fs.writeFile);
const unlinkAsync = promisify(fs.unlink);

const tempDir = path.join(process.cwd(), 'temp');
const tempDownloadDir = path.join(tempDir, 'downloads');


const getFileNameFromLocalPath = (localPath) => {
    const fileName = path.basename(localPath);
    return fileName;
}
const getFileNameFromURL = (fileUrl) => {
    const parsedUrl = new url(fileUrl);
    const fileName = path.basename(parsedUrl.pathname);
    return fileName;
}

export async function getVideoThumbnail(videoLocalPath) {
    try {
        const videoFileName = getFileNameFromLocalPath(videoLocalPath).split('.')[0];
        console.log("received video local path: ", videoLocalPath);

        return await new Promise(async (resolve, reject) => {
            try {
                resolve(`thumbnail file path: {} for video : ${videoFileName}`);
            } catch (err) {
                reject(err);
            }
        })
    } catch (err) {
        console.error('Error getVideoThumbnail:', err.stack);
        throw err;
    }
}

export async function generateThumbnail(videoUrl) {
    try {
        console.log("received video url: ", videoUrl);

        const response = await axios.get(videoUrl, { responseType: 'arraybuffer' });

        const ext = getFileNameFromURL(videoUrl).split('.').pop().toLowerCase();
        const tempVideoPath = path.join(tempDownloadDir, `/temp_video.${ext}`);

        if (!fs.existsSync(tempDownloadDir)) {
            fs.mkdirSync(tempDownloadDir, { recursive: true });
        }

        await writeFileAsync(tempVideoPath, response.data);

        return await new Promise(async (resolve, reject) => {
            try {
                const thumbnailPath = await getVideoThumbnail(tempVideoPath)
                await unlinkAsync(tempVideoPath);

                resolve(thumbnailPath);
            } catch (err) {
                reject(err);
            }
        })
    } catch (err) {
        console.error('Error generateThumbnail:', err.stack);
        throw err;
    }

}
