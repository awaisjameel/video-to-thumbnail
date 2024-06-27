import { getThumbnailWithPath, getThumbnailWithUrl } from "./utils.js";

(async () => {
    console.log("1 test start");
    const thumbnailPathUrl = await getThumbnailWithUrl('https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4');
    console.log("thumbnailPathUrl :", thumbnailPathUrl);
    console.log("1 test end");

    console.log("--------------------");

    console.log("2 test start");
    const thumbnailPathLocal = await getThumbnailWithPath('./test-video/test-001.mp4');
    console.log("thumbnailPathLocal :", thumbnailPathLocal);
    console.log("2 test end");
})()