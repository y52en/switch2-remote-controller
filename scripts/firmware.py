#!/usr/bin/env python3
"""Build and upload the ESP32-C3 firmware in an isolated PlatformIO core."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / "firmware" / "esp32-c3"
CORE_DIR = ROOT / ".cache" / "platformio"
FRAMEWORK = CORE_DIR / "packages" / "framework-espidf"
VENDOR_LIB = PROJECT / "third_party" / "esp32c3-bt-lib" / "libbtdm_app.a"

PROFILES = {
    "headless": "esp32c3-headless",
    "lcd-2424s012c": "esp32c3-2424s012c",
}

FRAMEWORK_VERSION = "6.0.1"
ORIGINAL_HASHES = {
    "components/bt/controller/lib_esp32c3_family/esp32c3/libbtdm_app.a":
        "42fe4f993e31e4de8e9fb97e2486f9f937776f7640e2df082f652da378433d0b",
    "components/bt/controller/esp32c3/bt.c":
        "a062cc59959ffb5f401d9ee02ba21b76b35dc8a725d6da787f4b9c8611bcfdfe",
    "components/bt/host/nimble/nimble/nimble/include/nimble/hci_common.h":
        "f1f7b08fad18533eb78c99b56c86235a9c3d45bd093caedd49d664de54fe85a7",
    "components/bt/host/nimble/nimble/nimble/host/src/ble_gap.c":
        "2a69e2b0be16c6f2afbfbf9408f74a9ec2c23bbbea50354b6d120df658eee035",
}
PATCHED_HASHES = {
    "components/bt/controller/esp32c3/bt.c":
        "0c205b9c84c2f62b13288103d907b7ee19259fe838d2eb2f834ed421eded5a3d",
    "components/bt/host/nimble/nimble/nimble/include/nimble/hci_common.h":
        "aebb28d880a7f7308aaedc2eb150dfeb0449effebe4a5cfd44d8fb933e08ca60",
    "components/bt/host/nimble/nimble/nimble/host/src/ble_gap.c":
        "7c68441f1e0bb188cfa5d974de9ec6d6dd37a55d9da71c947bea58ab41efb8dd",
}
VENDOR_LIB_HASH = "2c503e2f86294f7284cec7c879abb2ad3d3c76252b27d85d682cb643880f08e7"


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def source_digest(path: Path) -> str:
    """Hash source reproducibly while accepting platform-native line endings."""
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def environment() -> dict[str, str]:
    result = os.environ.copy()
    result["PLATFORMIO_CORE_DIR"] = str(CORE_DIR)
    result["GIT_CEILING_DIRECTORIES"] = os.pathsep.join(
        (str(PROJECT.parent), str(CORE_DIR.parent))
    )
    result.setdefault("PYTHONUTF8", "1")
    return result


def run(command: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    print("+", subprocess.list2cmdline(command), flush=True)
    return subprocess.run(
        command,
        cwd=ROOT,
        env=environment(),
        check=True,
        text=True,
        capture_output=capture,
    )


def platformio(*arguments: str) -> None:
    run([sys.executable, "-m", "platformio", *arguments])


def read_verified_framework_file(path: Path, relative: str) -> tuple[str, bool]:
    actual = source_digest(path)
    if actual == ORIGINAL_HASHES[relative]:
        return path.read_text(encoding="utf-8"), False
    if actual == PATCHED_HASHES[relative]:
        return path.read_text(encoding="utf-8"), True
    raise RuntimeError(
        f"Refusing to patch unexpected ESP-IDF file {relative}: {actual}"
    )


def verify_patched_file(path: Path, relative: str) -> None:
    actual = source_digest(path)
    expected = PATCHED_HASHES[relative]
    if actual != expected:
        raise RuntimeError(
            f"Patched ESP-IDF file failed SHA-256 verification "
            f"({relative}): {actual}"
        )


def prepare_framework() -> None:
    CORE_DIR.mkdir(parents=True, exist_ok=True)
    version_file = FRAMEWORK / "tools" / "cmake" / "version.cmake"
    if not version_file.is_file():
        platformio("pkg", "install", "--project-dir", str(PROJECT))
    else:
        print(f"Reusing isolated PlatformIO packages from {CORE_DIR}")

    if not version_file.is_file():
        raise RuntimeError(f"ESP-IDF package was not installed at {FRAMEWORK}")
    version_text = version_file.read_text(encoding="utf-8")
    expected_version_lines = (
        "set(IDF_VERSION_MAJOR 6)",
        "set(IDF_VERSION_MINOR 0)",
        "set(IDF_VERSION_PATCH 1)",
    )
    if not all(line in version_text for line in expected_version_lines):
        raise RuntimeError(
            f"Expected ESP-IDF {FRAMEWORK_VERSION}; version.cmake was unexpected"
        )

    if digest(VENDOR_LIB) != VENDOR_LIB_HASH:
        raise RuntimeError("Vendored ESP32-C3 controller library failed SHA-256 verification")

    library_relative = next(iter(ORIGINAL_HASHES))
    controller_library = FRAMEWORK / library_relative
    library_hash = digest(controller_library)
    if library_hash == ORIGINAL_HASHES[library_relative]:
        shutil.copyfile(VENDOR_LIB, controller_library)
    elif library_hash != VENDOR_LIB_HASH:
        raise RuntimeError(
            f"Refusing to replace unexpected controller library: {library_hash}"
        )

    bt_relative = "components/bt/controller/esp32c3/bt.c"
    bt_path = FRAMEWORK / bt_relative
    bt_text, bt_is_patched = read_verified_framework_file(bt_path, bt_relative)
    if not bt_is_patched:
        needle = "static void btdm_funcs_table_ready_wrapper(void)\n{"
        replacement = (
            "extern void ble_min_conn_interval_enable(uint16_t min_interval);\n\n"
            "static void btdm_funcs_table_ready_wrapper(void)\n{\n"
            "    ble_min_conn_interval_enable(3); "
            "// permits the Switch 2 5 ms interval"
        )
        if needle not in bt_text:
            raise RuntimeError("Unexpected ESP32-C3 controller initialization")
        bt_path.write_text(
            bt_text.replace(needle, replacement, 1), encoding="utf-8", newline="\n"
        )
    verify_patched_file(bt_path, bt_relative)

    hci_relative = (
        "components/bt/host/nimble/nimble/nimble/include/nimble/hci_common.h"
    )
    hci_path = FRAMEWORK / hci_relative
    hci_marker = "BLE_HCI_CONN_ITVL_MIN               (0x0004)"
    hci_text, hci_is_patched = read_verified_framework_file(hci_path, hci_relative)
    if not hci_is_patched:
        old = "BLE_HCI_CONN_ITVL_MIN               (0x0006)"
        if old not in hci_text:
            raise RuntimeError("Unexpected NimBLE connection interval definition")
        hci_path.write_text(
            hci_text.replace(old, hci_marker, 1), encoding="utf-8", newline="\n"
        )
    verify_patched_file(hci_path, hci_relative)

    gap_relative = "components/bt/host/nimble/nimble/nimble/host/src/ble_gap.c"
    gap_path = FRAMEWORK / gap_relative
    gap_marker = "params->itvl_min && params->itvl_min < 4"
    gap_text, gap_is_patched = read_verified_framework_file(gap_path, gap_relative)
    if not gap_is_patched:
        replacements = {
            "params->itvl_min && params->itvl_min < 6": gap_marker,
            "params->itvl_min < 0x0006": "params->itvl_min < 0x0004",
        }
        for old, new in replacements.items():
            if old not in gap_text:
                raise RuntimeError(f"Unexpected NimBLE GAP validation: {old}")
            gap_text = gap_text.replace(old, new)
        gap_path.write_text(gap_text, encoding="utf-8", newline="\n")
    verify_patched_file(gap_path, gap_relative)


def validate_chip(port: str) -> None:
    result = run(
        [sys.executable, "-m", "esptool", "--port", port, "chip-id"],
        capture=True,
    )
    output = result.stdout + result.stderr
    print(output, end="")
    if "ESP32-C3" not in output:
        raise RuntimeError(f"Refusing to upload: {port} is not an ESP32-C3")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("build", "upload", "clean"))
    parser.add_argument("--profile", choices=PROFILES, default="headless")
    parser.add_argument("--port", help="COM3, /dev/ttyACM0, or /dev/cu.*")
    arguments = parser.parse_args()
    environment_name = PROFILES[arguments.profile]

    prepare_framework()
    command = ["run", "--project-dir", str(PROJECT), "-e", environment_name]
    if arguments.action == "clean":
        platformio(*command, "--target", "clean")
        return 0
    if arguments.action == "upload":
        if not arguments.port:
            parser.error("upload requires --port")
        validate_chip(arguments.port)
        platformio(*command, "--target", "upload", "--upload-port", arguments.port)
        return 0
    platformio(*command)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
