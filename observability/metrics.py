import time
from flask import Response
from prometheus_client import (
    Histogram,
    Gauge,
    generate_latest,
    CONTENT_TYPE_LATEST,
)

# Histograms for durations
convert_preview_seconds = Histogram(
    "convert_preview_seconds", "STEP -> preview conversion time"
)
convert_final_seconds = Histogram(
    "convert_final_seconds", "STEP -> final asset conversion time"
)
dfm_seconds = Histogram("dfm_seconds", "DFM analysis time")
# Time to first frame from upload
ttfv_seconds = Histogram("ttfv_seconds", "Time from upload to preview ready")
# Size gauges
preview_size_bytes = Gauge("preview_size_bytes", "Preview file size in bytes")
final_size_bytes = Gauge("final_size_bytes", "Final file size in bytes")
# Cache ratio
cache_hit_ratio = Gauge("cache_hit_ratio", "Cache hit ratio")
_hits = 0
_total = 0


def record_cache_hit(hit: bool) -> None:
    global _hits, _total
    _total += 1
    if hit:
        _hits += 1
    cache_hit_ratio.set(_hits / _total if _total else 0)


def metrics_endpoint():
    return Response(generate_latest(), mimetype=CONTENT_TYPE_LATEST)


def setup_metrics(app) -> None:
    app.add_url_rule("/metrics", "metrics", metrics_endpoint)
