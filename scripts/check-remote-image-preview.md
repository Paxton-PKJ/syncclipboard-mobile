# Android remote image preview regression

`check-remote-image-preview.py` tests the actual pixels of downloaded remote images,
before and after a display resize. Use only a disposable Android emulator and a
dedicated backend directory. It replaces that backend's `SyncClipboard.json` with
three generated test image profiles and leaves the last profile in place.

Requirements: Python 3.9+, Pillow (`python -m pip install Pillow`), Android SDK
`adb`, and a built app installed on the test emulator. Keep Home open with the
remote clipboard card visible, enable remote polling, and disable automatic upload
so clipboard changes cannot replace the fixtures. No production backend is needed.

Create a new empty fixture directory, separate from screenshot evidence:

```bash
python scripts/check-remote-image-preview.py prepare --directory /path/to/preview-fixtures
python -m http.server 8765 --bind 127.0.0.1 --directory /path/to/preview-fixtures
```

The HTTP server runs in a separate terminal. This read-only HTTP server supplies
the WebDAV client's profile/image GET requests; it is not a full WebDAV server
and does not implement uploads. In another terminal, find the emulator serial
with `adb devices`, then forward its port:

```bash
adb -s <test-emulator-serial> reverse tcp:8765 tcp:8765
```

In the test app's Settings, add/select a **WebDAV** server with URL
`http://127.0.0.1:8765`, using arbitrary test credentials if required by the form.
Return to Home, enable remote polling, and wait until the initial green C image
is fully downloaded and displayed. The fixture server and emulator must use the
same port. Keep this test server selected throughout the check.

```bash
python scripts/check-remote-image-preview.py check \
  --directory /path/to/preview-fixtures \
  --output /path/to/new-preview-evidence \
  --serial <test-emulator-serial> \
  --restart-app com.jericx.syncclipboardmobile \
  --cycles 2 --settle-seconds 8
```

`--adb /path/to/adb` is optional when adb is not on PATH. `--restart-app` optionally
force-stops/reopens the app before the first cycle; omit it to test the already
running app. Increase `--settle-seconds` for slower polling or emulators. Each
cycle switches A (red), B (blue), and C (green), saves full screenshots before and
after resizing, and requires at least 10,000 exact fixture-color pixels in every
screenshot. Exit 0 and `PASS: all previews visible` mean all checks passed; missing
pixels or command errors produce a nonzero exit. This checks preview visibility,
not gesture handling or whether a destination app accepts a drag.

`prepare` refuses nonempty directories. `check` requires the marker written by
`prepare`, validates fixture hashes, and refuses overlapping fixture/evidence
directories or nonempty evidence directories. Use a fresh evidence directory for
each run. Screenshots can contain whatever is visible on the test emulator.

The check temporarily changes `adb shell wm size` and restores the original size
in `finally`, preserving any existing override instead of clearing it. It also
restores the size between images. A disconnected emulator or forcibly killed
Python process can prevent cleanup: the printed original display size tells you
which `adb -s <serial> shell wm size <original-override>` to restore, or use `reset`
if there was no override. Stop the HTTP server and remove the adb reverse mapping
after testing:

```bash
adb -s <test-emulator-serial> reverse --remove tcp:8765
```
