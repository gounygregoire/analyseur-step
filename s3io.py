# s3io.py
import os, mimetypes
from typing import Optional

import boto3
from botocore.client import Config
from botocore.exceptions import BotoCoreError, ClientError

def _env_ok() -> bool:
    return all(os.environ.get(k) for k in ("AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","S3_BUCKET"))

def _client_and_bucket():
    """
    Construit un client boto3 S3 robuste, compatible AWS / R2 / MinIO.
    Variables supportées:
      AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION (défaut: us-east-1)
      S3_BUCKET, S3_ENDPOINT (optionnel), S3_FORCE_PATH_STYLE=1 (optionnel)
    """
    if not _env_ok():
        raise RuntimeError("S3 not configured (missing AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY or S3_BUCKET)")

    region    = os.environ.get("AWS_REGION", "us-east-1")
    endpoint  = os.environ.get("S3_ENDPOINT") or None
    force_ps  = os.environ.get("S3_FORCE_PATH_STYLE", "0") == "1"
    bucket    = os.environ["S3_BUCKET"]

    cfg = Config(
        s3={"addressing_style": "path" if force_ps else "virtual"},
        retries={"max_attempts": 5, "mode": "standard"},
        signature_version="s3v4",
    )
    s3 = boto3.client(
        "s3",
        region_name=region,
        endpoint_url=endpoint,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
        config=cfg
    )
    return s3, bucket

def put_file(local_path: str, key: str, content_type: Optional[str] = None) -> bool:
    """Upload un fichier vers s3://<bucket>/<key>. Renvoie True/False."""
    try:
        s3, bucket = _client_and_bucket()
        if not content_type:
            content_type, _ = mimetypes.guess_type(local_path)
        if not content_type or local_path.lower().endswith(".xkt"):
            content_type = "application/octet-stream"
        extra = {}
        if content_type:
            extra["ContentType"] = content_type
        s3.upload_file(local_path, bucket, key, ExtraArgs=extra or None)
        return True
    except (BotoCoreError, ClientError, Exception) as e:
        print("[s3io] put_file error:", repr(e))
        return False

def get_file(key: str, dest_path: str) -> bool:
    """Télécharge s3://<bucket>/<key> vers dest_path. Renvoie True/False."""
    try:
        s3, bucket = _client_and_bucket()
        os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
        s3.download_file(bucket, key, dest_path)
        return True
    except (BotoCoreError, ClientError, Exception) as e:
        print("[s3io] get_file error:", repr(e))
        return False

def delete_file(key: str) -> bool:
    try:
        s3, bucket = _client_and_bucket()
        s3.delete_object(Bucket=bucket, Key=key)
        return True
    except (BotoCoreError, ClientError, Exception) as e:
        print("[s3io] delete_file error:", repr(e))
        return False

def presign_get(key: str, expires_sec: int = 3600) -> Optional[str]:
    """URL pré-signée GET (pratique si tu veux servir depuis S3)."""
    try:
        s3, bucket = _client_and_bucket()
        return s3.generate_presigned_url(
            ClientMethod="get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=expires_sec
        )
    except Exception as e:
        print("[s3io] presign_get error:", repr(e))
        return None
