# Native File Exports Design

## Purpose

Make the existing **Save Image** and **Export All Data (JSON)** actions work in the Capacitor Android application without changing their browser behavior.

The current handlers create a browser `Blob`, generate an object URL, and programmatically click an `<a download>` element. This works in a normal browser but does not start a file download from the Android WebView, so the application currently reports success without producing a usable file.

## Scope

This change covers exactly two export paths:

- A rendered comic page exported as a PNG from the Library page.
- A complete application-data backup exported as JSON from Settings.

Character, world, PDF/HTML, and any other export paths remain unchanged.

## Architecture

Add one focused file-export module that owns the platform split.

The module accepts a filename, MIME type, and either text or binary content. It detects a native Capacitor runtime with `Capacitor.isNativePlatform()`.

- **Native Android:** Write the content to `Directory.Cache` with `@capacitor/filesystem`, then pass the returned file URI to `@capacitor/share` so Android opens its share sheet.
- **Browser/PWA:** Create a `Blob`, object URL, and temporary download anchor, preserving the current download behavior.

Both page handlers call this module instead of implementing their own delivery mechanism. Page rendering and backup-data assembly remain in their existing modules.

## Data Flow

### Comic page PNG

1. The Library page renders the selected page to a canvas exactly as it does now.
2. The canvas produces an `image/png` blob.
3. The shared exporter receives the blob and `page-<number>.png` filename.
4. Android writes base64-encoded binary data to the cache and opens the share sheet. Browsers download the blob through the existing anchor mechanism.

### JSON backup

1. Settings reads the existing IndexedDB stores and removes panel `imageUrl` values exactly as it does now.
2. Settings serializes the backup object to JSON.
3. The shared exporter receives the JSON text and timestamped backup filename.
4. Android writes UTF-8 text to the cache and opens the share sheet. Browsers download a JSON blob through the existing anchor mechanism.

## Error Handling and User Feedback

- Native filesystem or share failures propagate back to the calling page.
- Each page logs the failure through the application's existing error logger where available and shows an error toast.
- A success toast is shown only after the export delivery mechanism succeeds. The native wording indicates that the share sheet was opened; it does not claim the user saved the file.
- Failure to produce a PNG blob remains an explicit render error.
- Temporary native files remain in the application cache, where Android may reclaim them. Repeated page exports overwrite the same page-number filename; JSON backups remain timestamped.

## Dependencies and Native Integration

Add Capacitor-compatible versions of:

- `@capacitor/filesystem`
- `@capacitor/share`

Run Capacitor sync so the Android Gradle configuration registers both plugins. The existing Android `FileProvider` cache path already permits sharing files written beneath the app cache.

## Testing

Use test-driven development for the shared export module and integrations:

- Native runtime routes through Filesystem and Share rather than creating a download anchor.
- Binary PNG data is written in the base64 format expected by Filesystem.
- JSON text is written as UTF-8.
- The file URI returned by Filesystem is supplied to Share with the correct title and MIME type.
- Browser runtime preserves Blob/object-URL/anchor behavior.
- Object URLs are revoked after browser delivery.
- Native errors reject so callers can show an error instead of false success.
- The Library and Settings handlers use the shared exporter with their expected filenames and MIME types.

After focused tests pass, run the repository's full unit tests, coverage, lint, formatting check, TypeScript check, production build, Capacitor sync, and Android debug build when the installed Android toolchain permits it.

## Acceptance Criteria

- Tapping **Save Image** in the Android application opens the share sheet with a valid PNG attachment.
- Tapping **Export All Data (JSON)** in the Android application opens the share sheet with a valid JSON attachment.
- Cancelling or completing the share sheet never produces a false “downloaded” claim.
- Files keep the existing user-facing names and correct MIME types.
- The two actions continue to download normally in web browsers.
- Filesystem/share failures produce an error toast and are logged rather than being reported as successful exports.
