let videoRunning = true;

function isVideoRunning() {
  return videoRunning;
}

function startVideo() {
  videoRunning = true;
  return getStatus();
}

function stopVideo() {
  videoRunning = false;
  return getStatus();
}

function getStatus() {
  return { videoRunning };
}

module.exports = { getStatus, isVideoRunning, startVideo, stopVideo };
