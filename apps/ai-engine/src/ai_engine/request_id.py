import re
import uuid
from contextvars import ContextVar

REQUEST_ID_HEADER = "x-request-id"

# request_id is a correlation identifier only. It is never used for authorization.
_SAFE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)


def resolve_request_id(inbound: str | None) -> str:
    if inbound is not None and _SAFE.fullmatch(inbound):
        return inbound
    return str(uuid.uuid4())
