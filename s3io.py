# s3io.py
import os, pathlib, boto3, botocore

_S3_ENDPOINT = os.getenv("S3_ENDPOINT")
_S3_BUCKET   = os.getenv("S3_BUCKET")
_S3_REGION   = os.getenv("S3_REGION", "us-east-1")
_S3_KEY      = os.getenv("S3_ACCESS_KEY")
_S3_SECRET   = os.getenv("S3_SECRET_KEY")

def _client():
    if not (_S3_ENDPOINT and _S3_BUCKET and _S3_KEY and _S3_SECRET):
        raise RuntimeError("S3 not configured (S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY)")
    return boto3.client(
        "s3",
        endpoint_url=_S3_ENDPOINT,
        region_name=_S3_REGION,
        aws_access_key_id=_S3_KEY,
        aws_secret_access_key=_S3_SECRET,
        config=boto3.session.Config(signature_version="s3v4"),
    )

def put_file(local_path: str, key: str, content_type: str | None = None):
    c = _client()
    extra = {"ContentType": content_type} if content_type else {}
    c.upload_file(local_path, _S3_BUCKET, key, ExtraArgs=extra)

def get_file(key: str, local_path: str) -> bool:
    c = _client()
    pathlib.Path(local_path).parent.mkdir(parents=True, exist_ok=True)
    try:
        c.download_file(_S3_BUCKET, key, local_path)
        return True
    except botocore.exceptions.ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey"):
            return False
        raise

def exists(key: str) -> bool:
    c = _client()
    try:
        c.head_object(Bucket=_S3_BUCKET, Key=key)
        return True
    except botocore.exceptions.ClientError:
        return False

def url_for(key: str) -> str:
    # utile si tu veux un lien public signé (non requis ici)
    return f"{_S3_ENDPOINT.rstrip('/')}/{_S3_BUCKET}/{key}"
