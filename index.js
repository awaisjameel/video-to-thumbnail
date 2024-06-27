import { getThumbnailWithPath, getThumbnailWithUrl } from "./utils.js";

(async () => {
    console.log("test start");
    const thumbnailPathLocal = await getThumbnailWithPath('./test-video/test-001.mp4');
    console.log("thumbnailPathLocal :", thumbnailPathLocal);
    console.log("test end");

    console.log("--------------------");

    console.log("test start");
    const thumbnailPathUrl = await getThumbnailWithUrl('https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4');
    console.log("thumbnailPathUrl :", thumbnailPathUrl);
    console.log("test end");
})()