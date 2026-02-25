import sys
from faster_whisper import WhisperModel

model = WhisperModel("base", device="cpu", compute_type="int8")
segments, _ = model.transcribe(sys.argv[1])
print(" ".join(s.text.strip() for s in segments))
