"""Allow ``python -m inat_vision_saliency`` when PYTHONPATH includes the tool root."""

from inat_vision_saliency.cli import main

if __name__ == "__main__":
    main()
