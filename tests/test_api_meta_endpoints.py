"""Tests des endpoints méta de l'API (/health, /_routes)."""


def test_api_health_endpoint(api_client):
    resp = api_client.get("/api/health")
    assert resp.status_code == 200
    assert resp.get_json() == {"ok": True}


def test_api_routes_lists_status_endpoint(api_client):
    resp = api_client.get("/api/_routes")
    assert resp.status_code == 200
    payload = resp.get_json()
    routes = payload.get("routes", [])

    assert any(
        route.get("rule") == "/api/files/<file_id>/status"
        and "GET" in (route.get("methods") or "").split(",")
        for route in routes
    )
