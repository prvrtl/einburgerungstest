import os
import sys
import tempfile
from pathlib import Path

os.environ["QUIZ_STATS_FILE"] = os.path.join(tempfile.mkdtemp(), "stats.json")
os.environ.setdefault("QUIZ_SECRET", "test-secret")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
