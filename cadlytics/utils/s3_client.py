"""S3 client helpers for Scaleway buckets.

This module centralises configuration of the S3 client and provides a
couple of convenience helpers with minimal retry logic. Configuration is
loaded from environment variables to remain compatible with Render.
"""

from __future__ import annotations

import os
from typing import Any, Callable, Iterable, Optional

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError


_CLIENT: Optional[Any] = None


def _build_client() -> Any:
    """Instantiate a boto3 S3 client configured for Scaleway."""

    endpoint_url = os.getenv("S3_ENDPOINT")
    region = os.getenv("AWS_REGION")
    access_key = os.getenv("AWS_ACCESS_KEY_ID")
    secret_key = os.getenv("AWS_SECRET_ACCESS_KEY")
    force_path_style = os.getenv("S3_FORCE_PATH_STYLE", "1") not in {"", "0", "false", "False"}

    if not all([endpoint_url, region, access_key, secret_key]):
        raise RuntimeError("Missing S3 configuration environment variables")

    config = Config(s3={"addressing_style": "path" if force_path_style else "auto"})

    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
        config=config,
    )


def s3_client() -> Any:
    """Return a cached boto3 S3 client."""

    global _CLIENT
    if _CLIENT is None:
        _CLIENT = _build_client()
    return _CLIENT


def _bucket_name() -> str:
    bucket = os.getenv("S3_BUCKET")
    if not bucket:
        raise RuntimeError("S3_BUCKET environment variable is not set")
    return bucket


def _retry(action: str, func: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    last_exc: Optional[Exception] = None
    for attempt in range(1, 3):
        try:
            return func(*args, **kwargs)
        except (ClientError, BotoCoreError) as exc:
            last_exc = exc
            print(f"[s3_client] {action} failed (attempt {attempt}/2): {exc}")
    if last_exc:
        raise last_exc
    return None


def key_exists(key: str) -> bool:
    """Return True if the object key exists in the configured bucket."""

    bucket = _bucket_name()

    def _head() -> Any:
        return s3_client().head_object(Bucket=bucket, Key=key)

    try:
        _retry("head_object", _head)
        return True
    except ClientError as exc:
        error_code = exc.response.get("Error", {}).get("Code") if hasattr(exc, "response") else None
        if error_code in {"404", "NoSuchKey", "NotFound"}:
            return False
        raise


def download_to_file(key: str, dest_path: str) -> None:
    """Download an object to the given local path."""

    bucket = _bucket_name()

    def _download() -> None:
        s3_client().download_file(bucket, key, dest_path)

    _retry("download_file", _download)


def upload_file(src_path: str, key: str, public: bool = True) -> None:
    """Upload a local file to S3."""

    bucket = _bucket_name()
    extra_args = {"ACL": "public-read"} if public else None

    def _upload() -> None:
        if extra_args:
            s3_client().upload_file(src_path, bucket, key, ExtraArgs=extra_args)
        else:
            s3_client().upload_file(src_path, bucket, key)

    _retry("upload_file", _upload)


def find_first_existing(keys: Iterable[str]) -> Optional[str]:
    """Return the first key that exists in S3 from the provided iterable."""

    for key in keys:
        if key_exists(key):
            return key
    return None
