"""The authorized semantic view as ai-engine receives it from the api (contracts/semantic-model).

Only what planning needs is modelled. Unknown fields are ignored so the api can add to the view.
"""

from pydantic import BaseModel, ConfigDict


class _Loose(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)


class ViewMeasure(_Loose):
    id: str
    entity: str
    label: str
    unit: str
    description: str | None = None
    synonyms: list[str] = []
    default_time_dimension: str | None = None
    valid_dimensions: list[str] | None = None
    breakdown_measure: str | None = None
    additivity: str | None = None
    polarity: str | None = None


class ViewHierarchy(_Loose):
    name: str
    level: int


class ViewDimension(_Loose):
    id: str
    label: str
    type: str
    synonyms: list[str] = []
    hierarchy: ViewHierarchy | None = None
    diagnostic: bool = False


class ViewSettings(_Loose):
    currency: str = "INR"
    timezone: str = "Asia/Kolkata"
    fiscal_year_start_month: int = 4
    number_format: str | None = None


class ViewRule(_Loose):
    id: str
    label: str
    value: float
    unit: str


class GlossaryTerm(_Loose):
    term: str
    definition: str
    maps_to: str | None = None


class AuthorizedView(_Loose):
    semantic_model_version: int
    tenant_settings: ViewSettings
    business_rules: list[ViewRule] = []
    measures: list[ViewMeasure] = []
    dimensions: list[ViewDimension] = []
    glossary: list[GlossaryTerm] = []
