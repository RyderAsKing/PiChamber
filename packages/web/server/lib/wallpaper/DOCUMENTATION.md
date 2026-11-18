# Wallpaper picture

Holds the one picture a server shows behind the new-session screen when the
`draftWallpaper` UI setting is `image`. How it shows (`draftWallpaperImageStyle`:
photo, dither or ASCII) and which picture the clients expect
(`draftWallpaperImageVersion`) are UI settings; this module only stores bytes.

## Files

- `store.js`: `<dataDir>/wallpaper/image` and `image.json` (`{ version, type }`).
- `routes.js`: `GET`, `PUT` and `DELETE /api/wallpaper-image`, behind the
  global `/api` auth gate.

## Invariants

- The type comes from the file's first bytes. Only PNG, JPEG and WebP are
  accepted (no SVG: it can carry script). Responses send `nosniff`.
- `version` is the first 16 hex characters of the bytes' SHA-256. A record
  whose version does not match the stored picture reads as no picture, so a
  crash between the two writes never serves a picture under the wrong name.
- A refused upload (too large, unknown type) leaves the previous picture.
- The size cap (8 MB) only stops abuse: the UI scales pictures to at most
  2560 px on the long side and re-encodes them before sending.
- `GET` answers `private, no-cache` with an ETag; clients key their copy by
  version and fetch again only when the setting names a new one.
