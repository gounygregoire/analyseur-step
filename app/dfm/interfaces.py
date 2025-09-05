from __future__ import annotations


from pydantic import BaseModel, Field, field_validator


class DFMInput(BaseModel):
    """Entrée standardisée pour l'analyse DFM."""

    file_id: str
    step_path: str
    demold_axis: tuple[float, float, float]
    material_profile: dict

    @field_validator("step_path")
    @classmethod
    def _check_step_path(cls, v: str) -> str:
        if not v:
            raise ValueError("step_path is required")
        return v

    @field_validator("demold_axis")
    @classmethod
    def _check_demold_axis(cls, v: tuple[float, float, float]) -> tuple[float, float, float]:
        if all(abs(c) < 1e-6 for c in v):
            raise ValueError("demold_axis cannot be the zero vector")
        return v


class DFMResult(BaseModel):
    """Résultat normalisé de l'analyse DFM."""

    metrics: dict = Field(default_factory=dict)
    issues: list[dict] = Field(default_factory=list)
    heatmaps: dict = Field(default_factory=dict)
    views: dict = Field(default_factory=dict)
    report_paths: dict = Field(default_factory=dict)
    flags: dict = Field(default_factory=dict)
