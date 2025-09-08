from __future__ import annotations


from typing import Literal

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


class IssueLocation(BaseModel):
    face_id: int
    point: tuple[float, float, float]
    value: float


class Issue(BaseModel):
    type: Literal["THICKNESS", "DRAFT", "RADIUS", "UNDERCUT", "WARP_RISK"]
    severity: Literal["info", "warn", "error"]
    message: str
    locations: list[IssueLocation] = Field(default_factory=list)


class HeatmapEntry(BaseModel):
    face_id: int
    value: float


class Heatmap(BaseModel):
    metric: str
    range: tuple[float, float]
    per_face: list[HeatmapEntry] = Field(default_factory=list)


class Summary(BaseModel):
    mass_g: float
    bbox_mm: tuple[float, float, float]
    projected_area_mm2: float
    avg_thickness_mm: float
    min_thickness_mm: float
    wall_thickness_histogram: list[tuple[float, float, int]] = Field(default_factory=list)
    min_radius_mm: float
    draft_ok_ratio: float
    low_res: bool = False


class MaterialProfile(BaseModel):
    id: str
    draft_min_deg: float


class Axis(BaseModel):
    x: float
    y: float
    z: float


class DFMResult(BaseModel):
    """Résultat normalisé de l'analyse DFM."""

    job_id: str
    file_id: str
    summary: Summary
    issues: list[Issue] = Field(default_factory=list)
    heatmap: Heatmap
    axis: Axis
    material_profile: MaterialProfile
