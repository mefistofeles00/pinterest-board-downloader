# Pinterest Board Downloader

A Chrome extension that lists every pin in a Pinterest board and downloads all the images into a folder named after the board — in one click.

## Features

- **One board or all of them** — open a board and grab it, or open a profile and let it walk through every board automatically.
- **Full resolution** — thumbnail URLs are upgraded to the original image where available.
- **No download spam** — Chrome's download shelf/animation is suppressed while it works; progress shows inside the popup instead.
- **Fast** — 6 parallel downloads, not one-at-a-time.
- **Stop anytime** — a stop button cancels scanning or downloading mid-run and keeps whatever was already collected.
- **Survives long jobs** — a keep-alive keeps the service worker awake through thousands of images.

## Install (unpacked)

1. Download or clone this repo.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder.

## Usage

1. Open a Pinterest **board** page (`pinterest.com/user/board/`) or a **profile** page (`pinterest.com/user/`).
2. Click the extension icon.
3. On a board: **Scan** → **Download all**. On a profile: **Download all boards**.
4. Images land in `Downloads/<board name>/`.

## Notes

- Use it only on boards you own or have permission to save. Respect Pinterest's Terms of Service and image copyright.
- Video pins save their cover image, not the video.
- Secret boards aren't linked on the profile page, so the "all boards" mode skips them — open those individually.

## License

MIT
