"""MLX 是 Python 生态依赖；此处只负责本地转写，不替代 AI 内容分析。"""
import json
import sys
from pathlib import Path

import mlx_whisper

audio, target, model = sys.argv[1:]
result = mlx_whisper.transcribe(audio, path_or_hf_repo=model, word_timestamps=True)
segments = [{"start": row["start"], "end": row["end"], "text": row["text"]}
            for row in result["segments"] if row["text"].strip()]
Path(target).write_text(json.dumps({"engine": "mlx-whisper", "model": model,
                                  "language": result.get("language"), "segments": segments},
                                 ensure_ascii=False, indent=2) + "\n")
