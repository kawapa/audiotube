# AudioTube

A Chrome extension that plays YouTube as **audio only** and actually stops the video stream from being downloaded. It doesn't just hide the picture.

In one test, a 3:40 song used **~4.3 MB** of `videoplayback` traffic, about 1 MB per minute. With video the same song usually takes 20–40 MB.

## How it works

YouTube's web player streams media over **SABR**: it sends `POST` requests to `googlevideo.com/videoplayback?...&sabr=1` with a protobuf body. AudioTube runs in the page and does two things:

1. **Patches the SABR request.** The request's `ClientAbrState` message has a track-type bitfield (field 40, normally `3` = audio + video). AudioTube sets it to `1` (audio only), so the server sends audio segments only (e.g. itag 251, Opus).
2. **Gives the player a fake video buffer.** The player still creates a video `SourceBuffer` and would stall waiting for video data. AudioTube replaces it with a stub that throws away whatever is appended and reports the whole duration as buffered.

The protobuf field numbers are reverse-engineered, not taken from an official schema.

## Install

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.

## Usage

Click the extension icon and toggle **Audio only**. Open YouTube tabs reload so the change takes effect. Audio only is on by default.

## Debugging

In the YouTube tab's DevTools console:

```js
localStorage.audiotube_debug = '1'   // then reload the page
```

The console then shows the structure of the SABR requests and, for each response, how many bytes arrived per itag. Run `localStorage.removeItem('audiotube_debug')` to turn it off.

To measure traffic, filter the Network tab by `videoplayback` and read the "transferred" total for the filtered requests.

## Limitations

- YouTube changes its player and streaming protocol often, so this can break at any time.
- The video area shows the player's placeholder instead of a picture.
- Only tested on regular videos and playlists. Seeking, live streams and ads have not been tested.

## Disclaimer

Not affiliated with or endorsed by YouTube or Google. Intended for personal use. Modifying how the player works may conflict with YouTube's Terms of Service.
