#!/usr/bin/env python3
# Back-compat shim: ``python tools/inat_vision_saliency/saliency.py …``
# Prefer: ``npm run vision-saliency`` or ``python -m inat_vision_saliency`` (see INTEGRATION.md).
import sys
from pathlib import Path

_TOOL = Path(__file__).resolve().parent
if str(_TOOL) not in sys.path:
    sys.path.insert(0, str(_TOOL))

from inat_vision_saliency.cli import main

if __name__ == "__main__":
    main()
