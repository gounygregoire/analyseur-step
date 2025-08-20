import os
from typing import Optional

try:
    import boto3
except Exception:  # pragma: no cover
    boto3 = None

S3_ENDPOINT = os.getenv('S3_ENDPOINT')
S3_ACCESS_KEY = os.getenv('S3_ACCESS_KEY')
S3_SECRET_KEY = os.getenv('S3_SECRET_KEY')
S3_REGION = os.getenv('S3_REGION')
S3_BUCKET = os.getenv('S3_BUCKET', 'cadlytics-assets')
CDN_BASE_URL = os.getenv('CDN_BASE_URL')

_s3_client = None
if boto3 and S3_BUCKET:
    _s3_client = boto3.client(
        's3',
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=S3_ACCESS_KEY,
        aws_secret_access_key=S3_SECRET_KEY,
        region_name=S3_REGION,
    )

CACHE_CONTROL = 'public, max-age=31536000, immutable'

def put_asset(local_path: str, key: str, content_type: str) -> str:
    if not _s3_client or not S3_BUCKET:
        raise RuntimeError('S3 not configured')
    extra = {
        'ContentType': content_type,
        'CacheControl': CACHE_CONTROL,
    }
    _s3_client.upload_file(local_path, S3_BUCKET, key, ExtraArgs=extra)
    return key

def get_signed_url(key: str, expires: int = 3600) -> Optional[str]:
    if not key:
        return None
    if CDN_BASE_URL:
        return f"{CDN_BASE_URL.rstrip('/')}/{key}"
    if _s3_client and S3_BUCKET:
        return _s3_client.generate_presigned_url(
            'get_object',
            Params={'Bucket': S3_BUCKET, 'Key': key},
            ExpiresIn=expires,
        )
    return key
