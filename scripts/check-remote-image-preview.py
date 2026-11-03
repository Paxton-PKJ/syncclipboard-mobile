"""Exercise actual Android image visibility against an isolated WebDAV fixture server."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import time

from PIL import Image, ImageDraw


COLORS = {"A": (255, 0, 0), "B": (0, 0, 255), "C": (0, 128, 0)}
MARKER = ".remote-image-preview-fixtures"
MARKER_CONTENT = "remote-image-preview-fixtures-v1\n"


def prepare(directory):
    """Create disposable server data; never overwrite an existing directory's data."""
    directory.mkdir(parents=True, exist_ok=True)
    if any(directory.iterdir()):
        raise SystemExit("Fixture directory must be empty")
    (directory / "file").mkdir()
    for label, color in COLORS.items():
        image = Image.new("RGB", (640, 400), color)
        ImageDraw.Draw(image).text((200, 180), "PREVIEW " + label, fill="white")
        path = directory / "file" / (label + ".png")
        image.save(path)
        data = path.read_bytes()
        profile = {
            "type": "Image", "text": path.name,
            "hash": hashlib.sha256(data).hexdigest().upper(),
            "hasData": True, "dataName": path.name, "size": len(data),
        }
        (directory / (label + ".json")).write_text(json.dumps(profile), encoding="utf-8")
    shutil.copyfile(directory / "C.json", directory / "SyncClipboard.json")
    (directory / MARKER).write_text(MARKER_CONTENT, encoding="utf-8")
    print("Prepared disposable WebDAV fixtures in " + str(directory))


def check(args):
    directory = args.directory.resolve()
    marker = directory / MARKER
    if not marker.is_file() or marker.read_text(encoding="utf-8") != MARKER_CONTENT:
        raise SystemExit("Use prepare first; refusing to write an unmarked server directory")
    # Validate every input before replacing the served profile or changing the display.
    for label in COLORS:
        profile = json.loads((directory / (label + ".json")).read_text(encoding="utf-8"))
        data = (directory / "file" / (label + ".png")).read_bytes()
        if profile["hash"] != hashlib.sha256(data).hexdigest().upper():
            raise SystemExit("Fixture image/hash mismatch: " + label)
    output = args.output.resolve()
    if output.is_relative_to(directory) or directory.is_relative_to(output):
        raise SystemExit("Evidence and fixture directories must be separate")
    args.output.mkdir(parents=True, exist_ok=True)
    if any(args.output.iterdir()):
        raise SystemExit("Evidence directory must be empty")

    def adb(*command):
        return subprocess.run(
            [args.adb, "-s", args.serial, *command], check=True, capture_output=True
        ).stdout

    def capture(name, label):
        data = adb("exec-out", "screencap", "-p")
        (args.output / (name + ".png")).write_bytes(data)
        image = Image.open(io.BytesIO(data)).convert("RGB")
        count = sum(pixel == COLORS[label] for pixel in image.getdata())
        print(f"{name}: size={image.size} image-color-pixels={count}", flush=True)
        return count >= 10000

    if adb("shell", "getprop", "ro.kernel.qemu").strip() != b"1":
        raise SystemExit("Use a disposable Android emulator, not a personal device")
    original_size = adb("shell", "wm", "size").decode("utf-8")
    override = re.search(r"Override size:\s*(\d+x\d+)", original_size)
    restore_size = override.group(1) if override else "reset"
    baseline = re.search(r"(?:Override|Physical) size:\s*(\d+x\d+)", original_size)
    if not baseline:
        raise SystemExit("Cannot determine original display size; refusing to resize")
    baseline_size = override.group(1) if override else baseline.group(1)
    resize_size = "1000x2200" if baseline_size != "1000x2200" else "1080x2400"
    print(f"Original display: {original_size.strip()}; restoring {restore_size}", flush=True)
    failures = []
    try:
        if args.restart_app:
            adb("shell", "am", "force-stop", args.restart_app)
            adb("shell", "monkey", "-p", args.restart_app, "1")
            time.sleep(args.settle_seconds)
        for cycle in range(1, args.cycles + 1):
            for label in COLORS:
                temporary_profile = directory / ".SyncClipboard.json.tmp"
                shutil.copyfile(directory / (label + ".json"), temporary_profile)
                temporary_profile.replace(directory / "SyncClipboard.json")
                time.sleep(args.settle_seconds)
                name = f"{cycle}-{label}"
                if not capture(name + "-no-resize", label):
                    failures.append(name + "-no-resize")
                # A resize used to be the only way to reveal the otherwise blank image.
                adb("shell", "wm", "size", resize_size)
                time.sleep(2)
                if not capture(name + "-resized", label):
                    failures.append(name + "-resized")
                adb("shell", "wm", "size", restore_size)
                time.sleep(2)
    finally:
        adb("shell", "wm", "size", restore_size)
    print("FAIL: " + ", ".join(failures) if failures else "PASS: all previews visible", flush=True)
    return bool(failures)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--directory", type=Path, required=True)
    check_parser = subparsers.add_parser("check")
    check_parser.add_argument("--directory", type=Path, required=True)
    check_parser.add_argument("--output", type=Path, required=True)
    check_parser.add_argument("--adb", default="adb")
    check_parser.add_argument("--serial", required=True)
    check_parser.add_argument("--settle-seconds", type=float, default=8)
    check_parser.add_argument("--cycles", type=int, default=1)
    check_parser.add_argument("--restart-app", metavar="PACKAGE")
    args = parser.parse_args()
    if args.command == "check" and (args.cycles < 1 or args.settle_seconds <= 0):
        parser.error("--cycles must be at least 1 and --settle-seconds must be positive")
    if args.command == "prepare":
        prepare(args.directory)
        return 0
    return check(args)


if __name__ == "__main__":
    raise SystemExit(main())
