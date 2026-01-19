import ThumbnailGenerator from './utils.js';
(async () => {
    const thumbnailGenerator = new ThumbnailGenerator();
    const videosList = [
        './test-video/test-001.mp4',
        'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
    ];

    const promises = [];
    videosList.forEach((videoPathOrUrl, index) => {
        promises.push((async () => {
            console.time(`Test | ${index + 1}`);
            const thumbnailPathUrl = await thumbnailGenerator.getVideoThumbnail(videoPathOrUrl);
            console.log("thumbnailPathUrl :", thumbnailPathUrl);
            console.timeEnd(`Test | ${index + 1}`);
        })());
    });
    await Promise.all(promises);

    console.log("-------------Starting Concurrent Test-------------");

    const conPromises = videosList.map((videoPathOrUrl, index) => {
        console.time(`Concurrent Test | ${index + 1}`);
        return thumbnailGenerator.queueGetVideoThumbnail(videoPathOrUrl)
            .then(thumbnailUrl => {
                console.log("thumbnailPathUrl :", thumbnailUrl);
                console.timeEnd(`Concurrent Test | ${index + 1}`);
            })
            .catch(err => {
                console.error(`Error generating thumbnail for ${videoPathOrUrl}:`, err);
            });
    });
    await Promise.all(conPromises);
})()