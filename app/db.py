# >>> CADLYTICS PATCH: DB SHIM (BEGIN)
class _DummyDB:
    def __getattr__(self, name):
        def _noop(*a, **k):
            return None
        return _noop

db = _DummyDB()
# >>> CADLYTICS PATCH: DB SHIM (END)
