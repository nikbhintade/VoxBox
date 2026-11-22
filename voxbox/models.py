"""Speech-to-text Whisper GGML model catalog and background download manager."""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import requests

from .config import DATA_DIR

log = logging.getLogger(__name__)

HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"


@dataclass(frozen=True)
class ModelSpec:
    id: str
    name: str
    filename: str
    size_bytes: int
    size_label: str
    languages: str
    badge: str
    description: str
    recommended: bool = False

    @property
    def url(self) -> str:
        return f"{HF_BASE}/{self.filename}"


MODEL_CATALOG: list[ModelSpec] = [
    ModelSpec(
        id="large-v3-turbo-q8_0",
        name="Whisper Large v3 Turbo (Q8)",
        filename="ggml-large-v3-turbo-q8_0.bin",
        size_bytes=874_188_075,
        size_label="834 MB",
        languages="Multilingual (99 languages)",
        badge="Recommended",
        description="Best balance of speed, accuracy, and VRAM (~1.2 GB) on GPUs.",
        recommended=True,
    ),
    ModelSpec(
        id="large-v3-turbo",
        name="Whisper Large v3 Turbo (FP16)",
        filename="ggml-large-v3-turbo.bin",
        size_bytes=1_624_555_275,
        size_label="1.55 GB",
        languages="Multilingual (99 languages)",
        badge="Full Precision",
        description="Unquantized Turbo model for maximum fidelity on 8GB+ GPUs.",
    ),
    ModelSpec(
        id="large-v3-q5_0",
        name="Whisper Large v3 (Q5)",
        filename="ggml-large-v3-q5_0.bin",
        size_bytes=1_081_140_203,
        size_label="1.03 GB",
        languages="Multilingual (99 languages)",
        badge="Max Accuracy",
        description="Full Large v3 architecture for toughest accents and technical speech.",
    ),
    ModelSpec(
        id="medium-q8_0",
        name="Whisper Medium (Q8)",
        filename="ggml-medium-q8_0.bin",
        size_bytes=823_369_779,
        size_label="785 MB",
        languages="Multilingual (99 languages)",
        badge="Balanced",
        description="Solid multilingual accuracy with lower compute cost.",
    ),
    ModelSpec(
        id="small-q8_0",
        name="Whisper Small (Q8)",
        filename="ggml-small-q8_0.bin",
        size_bytes=264_464_607,
        size_label="252 MB",
        languages="Multilingual (99 languages)",
        badge="Lightweight",
        description="Compact multilingual model for modest GPUs or fast CPUs.",
    ),
    ModelSpec(
        id="base-en",
        name="Whisper Base (English)",
        filename="ggml-base.en.bin",
        size_bytes=147_964_211,
        size_label="141 MB",
        languages="English only",
        badge="Fast CPU",
        description="Lightweight English model that runs comfortably without a GPU.",
    ),
    ModelSpec(
        id="tiny-en",
        name="Whisper Tiny (English)",
        filename="ggml-tiny.en.bin",
        size_bytes=77_704_715,
        size_label="74 MB",
        languages="English only",
        badge="Ultra Fast",
        description="Smallest footprint for instant transcription on low-power machines.",
    ),
]

CATALOG_BY_ID: dict[str, ModelSpec] = {m.id: m for m in MODEL_CATALOG}


class ModelManager:
    """Lists, downloads (with live progress), and deletes local Whisper GGML models."""

    def __init__(self, models_dir: Path | None = None) -> None:
        self.models_dir = models_dir or (DATA_DIR / "models")
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        # model_id -> {"downloaded": int, "total": int, "error": str, "cancel": Event}
        self._downloads: dict[str, dict[str, Any]] = {}

    def resolve_path(self, model_id: str) -> Path | None:
        spec = CATALOG_BY_ID.get(model_id)
        if spec:
            return self.models_dir / spec.filename
        # Support custom local .bin files by stem/filename
        for p in self.models_dir.glob("*.bin"):
            if p.stem == model_id or p.name == model_id:
                return p
        return None

    def list_models(self, active_model_path: Path) -> list[dict[str, Any]]:
        active_resolved = Path(os.path.expanduser(str(active_model_path))).resolve()
        known_filenames: set[str] = set()
        items: list[dict[str, Any]] = []

        with self._lock:
            dl_snapshot = {
                k: {
                    "downloaded": v["downloaded"],
                    "total": v["total"],
                    "error": v["error"],
                    "active": v["active"],
                }
                for k, v in self._downloads.items()
            }

        for spec in MODEL_CATALOG:
            known_filenames.add(spec.filename)
            path = self.models_dir / spec.filename
            installed = path.is_file() and path.stat().st_size > 1_000_000
            is_active = installed and path.resolve() == active_resolved
            dl = dl_snapshot.get(spec.id)
            downloading = bool(dl and dl["active"])
            progress = 0
            if downloading and dl["total"] > 0:
                progress = min(99, int((dl["downloaded"] / dl["total"]) * 100))

            row = asdict(spec)
            row.update(
                {
                    "path": str(path),
                    "installed": installed,
                    "active": is_active,
                    "downloading": downloading,
                    "progress": progress,
                    "downloaded_mb": round((dl["downloaded"] if dl else 0) / (1024 * 1024), 1),
                    "total_mb": round((dl["total"] if dl and dl["total"] else spec.size_bytes) / (1024 * 1024), 1),
                    "error": dl["error"] if dl else "",
                    "custom": False,
                }
            )
            items.append(row)

        # Include any user-added custom .bin models in ~/.local/share/voxbox/models/
        if self.models_dir.exists():
            for p in sorted(self.models_dir.glob("*.bin")):
                if p.name in known_filenames:
                    continue
                size = p.stat().st_size
                items.append(
                    {
                        "id": p.stem,
                        "name": p.stem,
                        "filename": p.name,
                        "size_bytes": size,
                        "size_label": f"{size / (1024 * 1024):.0f} MB",
                        "languages": "Custom GGML",
                        "badge": "Custom",
                        "description": f"Local model file in {self.models_dir}",
                        "recommended": False,
                        "path": str(p),
                        "installed": True,
                        "active": p.resolve() == active_resolved,
                        "downloading": False,
                        "progress": 100,
                        "downloaded_mb": round(size / (1024 * 1024), 1),
                        "total_mb": round(size / (1024 * 1024), 1),
                        "error": "",
                        "custom": True,
                    }
                )
        return items

    def start_download(self, model_id: str) -> dict[str, Any]:
        spec = CATALOG_BY_ID.get(model_id)
        if not spec:
            raise ValueError(f"Unknown model id: {model_id}")

        target = self.models_dir / spec.filename
        if target.is_file() and target.stat().st_size > 1_000_000:
            return {"status": "already_installed", "id": model_id}

        with self._lock:
            existing = self._downloads.get(model_id)
            if existing and existing["active"]:
                return {"status": "downloading", "id": model_id}
            cancel_ev = threading.Event()
            self._downloads[model_id] = {
                "downloaded": 0,
                "total": spec.size_bytes,
                "error": "",
                "active": True,
                "cancel": cancel_ev,
            }

        threading.Thread(
            target=self._download_worker,
            args=(spec, cancel_ev),
            name=f"voxbox-dl-{model_id}",
            daemon=True,
        ).start()
        return {"status": "started", "id": model_id}

    def cancel_download(self, model_id: str) -> bool:
        with self._lock:
            state = self._downloads.get(model_id)
            if state and state["active"]:
                state["cancel"].set()
                return True
        return False

    def _download_worker(self, spec: ModelSpec, cancel_ev: threading.Event) -> None:
        self.models_dir.mkdir(parents=True, exist_ok=True)
        part_path = self.models_dir / f"{spec.filename}.part"
        final_path = self.models_dir / spec.filename
        log.info("Downloading Whisper model %s from %s", spec.id, spec.url)

        try:
            with requests.get(spec.url, stream=True, timeout=30.0) as r:
                r.raise_for_status()
                total = int(r.headers.get("Content-Length", spec.size_bytes))
                downloaded = 0
                with self._lock:
                    self._downloads[spec.id]["total"] = total

                with part_path.open("wb") as f:
                    for chunk in r.iter_content(chunk_size=1024 * 256):
                        if cancel_ev.is_set():
                            raise InterruptedError("Download cancelled")
                        if not chunk:
                            continue
                        f.write(chunk)
                        downloaded += len(chunk)
                        with self._lock:
                            self._downloads[spec.id]["downloaded"] = downloaded

            os.replace(part_path, final_path)
            log.info("Finished downloading %s (%d bytes)", spec.filename, final_path.stat().st_size)
            with self._lock:
                self._downloads[spec.id]["active"] = False
                self._downloads[spec.id]["error"] = ""
        except InterruptedError:
            log.info("Cancelled download for %s", spec.id)
            try:
                part_path.unlink(missing_ok=True)
            except Exception:
                pass
            with self._lock:
                self._downloads.pop(spec.id, None)
        except Exception as e:
            log.error("Model download failed for %s: %s", spec.id, e)
            try:
                part_path.unlink(missing_ok=True)
            except Exception:
                pass
            with self._lock:
                if spec.id in self._downloads:
                    self._downloads[spec.id]["active"] = False
                    self._downloads[spec.id]["error"] = str(e)

    def delete_model(self, model_id: str, active_model_path: Path) -> bool:
        path = self.resolve_path(model_id)
        if not path or not path.is_file():
            return False
        if path.resolve() == Path(os.path.expanduser(str(active_model_path))).resolve():
            raise ValueError("Cannot delete the currently active model. Switch to another model first.")
        path.unlink()
        log.info("Deleted model %s", path)
        return True
