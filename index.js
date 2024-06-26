import { generateThumbnail } from "./utils.js";

(async () => {
    const thumbnailPath = await generateThumbnail('https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4');
    console.log(thumbnailPath);
})()