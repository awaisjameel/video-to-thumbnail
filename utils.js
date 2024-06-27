import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';

import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const writeFileAsync = promisify(fs.writeFile);
const unlinkAsync = promisify(fs.unlink);

const thumbsDir = 'thumbnails';
const currentDirPath = process.cwd();
const tempDirPath = path.join(currentDirPath, 'temp');
const tempDownloadDirPath = path.join(tempDirPath, 'downloads');
const thumbsDirPath = path.join(currentDirPath, thumbsDir);

const getFileNameFromLocalPath = (localPath) => {
    const fileName = path.basename(localPath);
    return fileName;
}
const getFileNameFromURL = (fileUrl) => {
    const parsedUrl = new URL(fileUrl);
    const fileName = path.basename(parsedUrl.pathname);
    return fileName;
}

ffmpeg.setFfmpegPath(ffmpegPath);

export async function generateThumbnail(videoLocalPath) {
    try {
        const videoFileName = getFileNameFromLocalPath(videoLocalPath).split('.')[0];
        const ext = getFileNameFromLocalPath(videoLocalPath).split('.')[1];
        const thumbnailFilename = `${videoFileName}_thumbnail.png`;
        const thumbnailFileUrl = `/${thumbsDir}/${thumbnailFilename}`;
        console.log("generateThumbnail | received video local path: ", videoLocalPath);

        return new Promise((resolve, reject) => {
            ffmpeg(videoLocalPath)
                .inputFormat(ext)
                .on('filenames', function (filenames) {
                    console.log('generateThumbnail | Will generate thumbnails: ', filenames);
                })
                .on('end', async function () {
                    console.log('generateThumbnail | Generated thumbnail successfully at: ', thumbnailFileUrl);

                    resolve(thumbnailFileUrl);
                })
                .on('error', async function (err) {
                    console.error('generateThumbnail | Error generating thumbnail: ', err.stack);
                    reject(err);
                })
                .screenshots({
                    // count: 1,
                    timemarks: ['0.1'], // Capture at 0.1 seconds
                    // size: '360x640',
                    folder: thumbsDirPath,
                    filename: thumbnailFilename,
                });
        });
    } catch (err) {
        console.error('generateThumbnail | Error: ', err.stack);
        throw err;
    }
}

export async function getThumbnailWithPath(videoLocalPath) {
    try {
        console.log("getThumbnailWithPath | received video local path: ", videoLocalPath);

        return await new Promise(async (resolve, reject) => {
            try {
                resolve(await generateThumbnail(videoLocalPath));
            } catch (err) {
                reject(err);
            }
        })
    } catch (err) {
        console.error('getThumbnailWithPath | Error: ', err.stack);
        throw err;
    }
}

export async function getThumbnailWithUrl(videoUrl) {
    try {
        console.log("getThumbnailWithUrl | received video url: ", videoUrl);

        const response = await axios.get(videoUrl, { responseType: 'arraybuffer' });

        const videoFileName = getFileNameFromURL(videoUrl).split('.')[0];
        const ext = getFileNameFromURL(videoUrl).split('.').pop().toLowerCase();
        const tempVideoPath = path.join(tempDownloadDirPath, `/${videoFileName}.${ext}`);

        if (!fs.existsSync(tempDownloadDirPath)) {
            fs.mkdirSync(tempDownloadDirPath, { recursive: true });
        }

        await writeFileAsync(tempVideoPath, response.data);

        return await new Promise(async (resolve, reject) => {
            try {
                const thumbnailPath = await getThumbnailWithPath(tempVideoPath)
                await unlinkAsync(tempVideoPath);

                resolve(thumbnailPath);
            } catch (err) {
                reject(err);
            }
        })
    } catch (err) {
        console.error('getThumbnailWithUrl | Error: ', err.stack);
        throw err;
    }

}
