from app.storage import files


def test_upload_success(client, sample_step_path):
    with open(sample_step_path("cube_small.step"), "rb") as fh:
        resp = client.post(
            "/api/upload",
            data={"file": (fh, "cube_small.step")},
            content_type="multipart/form-data",
        )
    assert resp.status_code == 200
    file_id = resp.get_json()["file_id"]
    assert files.get(file_id) is not None


def test_upload_missing_file(client):
    resp = client.post("/api/upload", data={})
    assert resp.status_code == 400
    assert resp.get_json()["error"] == "missing_file"
