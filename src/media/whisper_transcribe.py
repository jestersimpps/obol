#!/usr/bin/env python3
"""
whisper_transcribe.py — Transcribe audio files using faster-whisper.

Called by stt.js as: python3 whisper_transcribe.py <audio_file_path>

Uses the 'tiny' model for fast CPU inference (~140MB).
Outputs the transcribed text to stdout.
Exits with code 1 on failure.
"""

import sys

def transcribe(file_path):
    """Transcribe an audio file and return the text."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("ERROR: faster-whisper not installed. Run: pip3 install faster-whisper", file=sys.stderr)
        sys.exit(1)

    try:
        model = WhisperModel("tiny", device="cpu", compute_type="int8")
        segments, info = model.transcribe(file_path)
        text = " ".join(segment.text.strip() for segment in segments).strip()
        return text
    except Exception as e:
        print(f"ERROR: Transcription failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 whisper_transcribe.py <audio_file_path>", file=sys.stderr)
        sys.exit(1)

    file_path = sys.argv[1]
    result = transcribe(file_path)
    if result:
        print(result)
    else:
        sys.exit(1)
