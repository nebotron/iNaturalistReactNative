#!/usr/bin/env python3
"""Signs a simulator build ad hoc with the app's entitlements.

A simulator build made with CODE_SIGNING_ALLOWED=NO has no entitlements, and
without an application identifier every keychain call fails ("A required
entitlement isn't present"), which takes the API's auth check, and so every
request, down with it. This signs the nested code, then the app with the
project's entitlements file resolved for TEAM_ID, plus the application
identifier and keychain group a provisioned build would get.

    sign_simulator_app.py APP ENTITLEMENTS TEAM_ID
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


def resolve(value, substitutions: dict):
    if isinstance(value, str):
        for key, replacement in substitutions.items():
            value = value.replace(key, replacement)
        return value
    if isinstance(value, list):
        return [resolve(v, substitutions) for v in value]
    if isinstance(value, dict):
        return {k: resolve(v, substitutions) for k, v in value.items()}
    return value


def main() -> None:
    app, source, team = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    info = plistlib.loads((app / "Info.plist").read_bytes())
    bundle_id = info["CFBundleIdentifier"]
    entitlements = resolve(plistlib.loads(source.read_bytes()), {
        "$(CFBundleIdentifier)": bundle_id,
        "$(TeamIdentifierPrefix)": f"{team}.",
        "$(AppIdentifierPrefix)": f"{team}.",
    })
    entitlements["application-identifier"] = f"{team}.{bundle_id}"
    entitlements["com.apple.developer.team-identifier"] = team
    entitlements.setdefault("keychain-access-groups", [f"{team}.{bundle_id}"])

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
