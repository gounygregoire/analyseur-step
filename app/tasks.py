import time

def heavy_compute(x, fail=False):
    time.sleep(2)
    if fail:
        raise RuntimeError("Forced failure")
    return x * 2
