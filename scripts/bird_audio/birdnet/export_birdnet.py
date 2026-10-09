# Copies the Seattle model into the iOS bundle; export_catalog.py then writes
# the species table the Audio ID screen reads. Run from this directory:
#   python3 export_birdnet.py <repo root>
import shutil, sys
shutil.copy("audio_birds.onnx", f"{sys.argv[1]}/ios/iNaturalistReactNative/audio_birds.onnx")
