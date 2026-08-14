"""codex-audio: standalone speech-to-text on your ChatGPT subscription."""

from .auth import ChatGPTAuth
from .realtime import RealtimeTranscriber, Transcript

__all__ = ["ChatGPTAuth", "RealtimeTranscriber", "Transcript"]
__version__ = "0.1.0"
