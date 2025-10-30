"""Utilitaires S3 pour Scaleway avec gestion de retries simples."""
from __future__ import annotations

import os
import time
from functools import lru_cache
from typing import Any, Callable, Optional, Sequence

try:
    import boto3
    from botocore.config import Config
    from botocore.exceptions import BotoCoreError, ClientError
except ImportError as exc:  # pragma: no cover - dépendance obligatoire
    # boto3 est requis côté worker/web. On lève une erreur explicite au premier usage.
    boto3 = None  # type: ignore[assignment]
    Config = None  # type: ignore[assignment]
    BotoCoreError = ClientError = Exception  # type: ignore[assignment]
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


_S3_ENDPOINT_ENV = "S3_ENDPOINT"
_S3_BUCKET_ENV = "S3_BUCKET"
_S3_REGION_ENV = "AWS_REGION"
_S3_KEY_ENV = "AWS_ACCESS_KEY_ID"
_S3_SECRET_ENV = "AWS_SECRET_ACCESS_KEY"
_S3_FORCE_PATH_ENV = "S3_FORCE_PATH_STYLE"

_DEFAULT_REGION = "us-east-1"
_MAX_RETRIES = 2
_RETRY_SLEEP_SEC = 0.5


class S3ConfigurationError(RuntimeError):
    """Erreur levée lorsque la configuration S3 est incomplète."""


def _ensure_dependencies() -> None:
    """Vérifie que boto3 est bien importé."""
    if _IMPORT_ERROR is not None:
        raise RuntimeError(
            "boto3 est requis pour utiliser les utilitaires S3"
        ) from _IMPORT_ERROR


def _get_bucket_name() -> str:
    bucket = os.environ.get(_S3_BUCKET_ENV)
    if not bucket:
        raise S3ConfigurationError(
            f"Variable d'environnement {_S3_BUCKET_ENV} manquante pour S3"
        )
    return bucket


def _build_client() -> "boto3.client":
    _ensure_dependencies()

    access_key = os.environ.get(_S3_KEY_ENV)
    secret_key = os.environ.get(_S3_SECRET_ENV)
    if not access_key or not secret_key:
        missing = [
            name
            for name, value in ((_S3_KEY_ENV, access_key), (_S3_SECRET_ENV, secret_key))
            if not value
        ]
        raise S3ConfigurationError(
            "Variables d'environnement manquantes pour S3: " + ", ".join(missing)
        )

    endpoint = os.environ.get(_S3_ENDPOINT_ENV)
    region = os.environ.get(_S3_REGION_ENV, _DEFAULT_REGION)
    force_path = os.environ.get(_S3_FORCE_PATH_ENV, "0") == "1"

    config_kwargs = {"signature_version": "s3v4"}
    if force_path:
        config_kwargs["s3"] = {"addressing_style": "path"}

    config = Config(**config_kwargs)

    session = boto3.session.Session()
    return session.client(
        "s3",
        region_name=region,
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=config,
    )


@lru_cache(maxsize=1)
def s3_client() -> "boto3.client":
    """Retourne un client S3 configuré pour Scaleway."""
    return _build_client()


def _with_retries(action: str, func: Callable[..., Any], *args, **kwargs):
    last_error: Optional[Exception] = None
    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            return func(*args, **kwargs)
        except (ClientError, BotoCoreError, OSError) as exc:
            last_error = exc
            print(f"[s3] {action} tentative {attempt}/{_MAX_RETRIES} échouée: {exc}")
            if attempt < _MAX_RETRIES:
                time.sleep(_RETRY_SLEEP_SEC)
    if last_error is not None:
        raise last_error
    raise RuntimeError(f"Action {action} échouée sans exception explicite")


def key_exists(key: str) -> bool:
    """Retourne True si la clé existe dans le bucket configuré."""
    try:
        _with_retries(
            "head_object",
            s3_client().head_object,
            Bucket=_get_bucket_name(),
            Key=key,
        )
        return True
    except ClientError as exc:
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if status == 404:
            return False
        print(f"[s3] head_object erreur inattendue pour {key}: {exc}")
        return False
    except BotoCoreError as exc:
        print(f"[s3] head_object erreur bas niveau pour {key}: {exc}")
        return False


def download_to_file(key: str, dest_path: str) -> None:
    """Télécharge la clé S3 vers le chemin local donné."""
    os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
    try:
        _with_retries(
            "download_file",
            s3_client().download_file,
            _get_bucket_name(),
            key,
            dest_path,
        )
    except Exception as exc:  # pragma: no cover - défense supplémentaire
        raise RuntimeError(
            f"Téléchargement S3 échoué pour {key} -> {dest_path}: {exc}"
        ) from exc


def upload_file(src_path: str, key: str, public: bool = True) -> None:
    """Envoie un fichier local vers S3, éventuellement en lecture publique."""
    extra_args = {}
    if public:
        extra_args["ACL"] = "public-read"

    try:
        _with_retries(
            "upload_file",
            s3_client().upload_file,
            src_path,
            _get_bucket_name(),
            key,
            ExtraArgs=extra_args if extra_args else None,
        )
    except Exception as exc:  # pragma: no cover - défense supplémentaire
        raise RuntimeError(
            f"Upload S3 échoué pour {src_path} -> {key}: {exc}"
        ) from exc


def find_first_existing(keys: Sequence[str]) -> Optional[str]:
    """Retourne la première clé existante parmi la liste fournie."""
    for key in keys:
        if key_exists(key):
            return key
    return None
