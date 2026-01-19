import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { queue } from 'async';

dotenv.config();

ffmpeg.setFfmpegPath(ffmpegPath);

const config = {
    thumbsDir: process.env.THUMBS_DIR || 'thumbnails',
    tempDir: process.env.TEMP_DIR || 'temp',
};

const currentDirPath = process.cwd();
const tempDirPath = path.join(currentDirPath, config.tempDir);
const tempDownloadDirPath = path.join(tempDirPath, 'downloads');
const thumbsDirPath = path.join(currentDirPath, config.thumbsDir);

class ThumbnailGenerationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ThumbnailGenerationError';
    }
}

class ThumbnailGenerator {
    constructor() {
        this.thumbsDirPath = thumbsDirPath;
        this.tempDownloadDirPath = tempDownloadDirPath;

        // Initialize a queue to limit concurrency
        this.queue = queue(async (task, done) => {
            try {
                const result = await task();

                console.log("current task result: ", result);
                return result;
            } catch (error) {
                done(error);
            }
        }, 5);
    }

    async generateThumbnail(videoLocalPath) {
        const videoFileName = path.basename(videoLocalPath, path.extname(videoLocalPath));
        const ext = path.extname(videoLocalPath).substring(1);
        const thumbnailFilename = `${videoFileName}_thumbnail.png`;
        const thumbnailFileUrl = `/${config.thumbsDir}/${thumbnailFilename}`;

        console.log("generateThumbnail | received video local path: ", videoLocalPath);

        return new Promise((resolve, reject) => {
            ffmpeg(videoLocalPath)
                .inputFormat(ext)
                .on('filenames', (filenames) => {
                    console.log('generateThumbnail | Will generate thumbnails: ', filenames);
                })
                .on('end', () => {
                    console.log('generateThumbnail | Generated thumbnail successfully at: ', thumbnailFileUrl);
                    resolve(thumbnailFileUrl);
                })
                .on('error', (err) => {
                    console.error('generateThumbnail | Error generating thumbnail: ', err.stack);
                    reject(new ThumbnailGenerationError(err.message));
                })
                .screenshots({
                    timemarks: ['0.1'],
                    folder: this.thumbsDirPath,
                    filename: thumbnailFilename,
                });
        });
    }

    async getVideoThumbnailWithPath(videoLocalPath) {
        console.log("getVideoThumbnailWithPath | received video local path: ", videoLocalPath);
        return this.generateThumbnail(videoLocalPath);
    }

    async getVideoThumbnailWithUrl(videoUrl) {
        console.log("getVideoThumbnailWithUrl | received video url: ", videoUrl);

        const response = await axios.get(videoUrl, { responseType: 'arraybuffer' });
        const videoFileName = path.basename(videoUrl, path.extname(videoUrl));
        const ext = path.extname(videoUrl).substring(1);
        const tempVideoPath = path.join(this.tempDownloadDirPath, `${videoFileName}.${ext}`);

        await fs.mkdir(this.tempDownloadDirPath, { recursive: true });
        await fs.writeFile(tempVideoPath, response.data);

        try {
            return await this.getVideoThumbnailWithPath(tempVideoPath);
        } finally {
            await fs.unlink(tempVideoPath);
        }
    }

    async getVideoThumbnail(videoPathOrUrl) {
        try {
            const isUrl = videoPathOrUrl.startsWith('http');
            if (isUrl) {
                return this.getVideoThumbnailWithUrl(videoPathOrUrl);
            } else {
                return this.getVideoThumbnailWithPath(videoPathOrUrl);
            }
        } catch (err) {
            console.error('getVideoThumbnail | Error generating thumbnail: ', err);
            throw err;
        }
    }

    async queueGetVideoThumbnail(videoPathOrUrl) {
        return new Promise((resolve, reject) => {
            this.queue.push(() => this.getVideoThumbnail(videoPathOrUrl), (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result);
                }
            });
        });
    }
}

export default ThumbnailGenerator;
