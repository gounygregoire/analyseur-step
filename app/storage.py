"""Helpers pour les chemins de fichiers.

DFM lit STEP, viewer lit XKT.
"""
import os


class Storage:
    """Centralise l'accès aux fichiers locaux."""

    UPLOADS_DIR = "uploads"
    CONVERTED_DIR = "converted"
    DFM_ROOT = os.path.join("static", "dfm")

    @staticmethod
    def get_step_path(file_id: str) -> str:
        """Retourne le chemin du fichier STEP.

        Recherche dans ``uploads/`` les extensions usuelles. Raise FileNotFoundError si absent.
        """
        for ext in (".step", ".stp", ".STEP", ".STP"):
            path = os.path.join(Storage.UPLOADS_DIR, f"{file_id}{ext}")
            if os.path.exists(path):
                return path
        raise FileNotFoundError(f"STEP file not found for {file_id}")

    @staticmethod
    def get_xkt_path(file_id: str) -> str:
        """Retourne le chemin du fichier XKT pour le viewer.

        Lève FileNotFoundError si le fichier converti est introuvable.
        """
        path = os.path.join(Storage.CONVERTED_DIR, f"{file_id}.xkt")
        if os.path.exists(path):
            return path
        raise FileNotFoundError(f"XKT file not found for {file_id}")

    @staticmethod
    def ensure_dfm_dir(file_id: str) -> str:
        """Crée le dossier de sortie DFM si nécessaire et retourne son chemin."""
        dir_path = os.path.join(Storage.DFM_ROOT, file_id)
        os.makedirs(dir_path, exist_ok=True)
        return dir_path


__all__ = ["Storage"]
