#!/usr/bin/env python3
"""Signs a simulator build ad hoc, as Xcode's "Sign to Run Locally" does.

A simulator build made with CODE_SIGNING_ALLOWED=NO has no entitlements, and
without an application identifier every keychain call fails ("A required
entitlement isn't present"), which takes the API's auth check, and so every
request, down with it. This signs the nested code, then the app with the
application identifier and keychain group alone. The project's other
entitlements (iCloud, app groups) need a provisioning profile, and with them
in the signature SpringBoard refuses to launch the app.

    sign_simulator_app.py APP TEAM_ID
"""
import plistlib
import subprocess
import sys
import tempfile
from pathlib import Path


def sign(path: Path, entitlements: Path | None = None) -> None:
    command = ["codesign", "--force", "--sign", "-", "--timestamp=none"]
    if entitlements:
        command += ["--entitlements", str(entitlements)]
    subprocess.run(command + [str(path)], check=True)


def main() -> None:
    app, team = Path(sys.argv[1]), sys.argv[2]
    bundle_id = plistlib.loads((app / "Info.plist").read_bytes())["CFBundleIdentifier"]
    entitlements = {
        "application-identifier": f"{team}.{bundle_id}",
        "keychain-access-groups": [f"{team}.{bundle_id}"],
        "get-task-allow": True,
    }

    # Innermost first: codesign won't seal a bundle around unsigned code
    nested = sorted(
        [p for pattern in ("Frameworks/*.framework", "Frameworks/*.dylib", "PlugIns/*.appex")
         for p in app.glob(pattern)],
        key=lambda p: -len(p.parts),
    )
    for path in nested:
        sign(path)
    with tempfile.NamedTemporaryFile(suffix=".plist") as file:
        file.write(plistlib.dumps(entitlements))
        file.flush()
        sign(app, Path(file.name))
    print(f"Signed {app} as {team}.{bundle_id}")


if __name__ == "__main__":
    main()
