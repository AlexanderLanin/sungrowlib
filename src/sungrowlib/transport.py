import logging
from typing import Protocol

from sungrowlib.deserialization import DecodedSignalValues
from sungrowlib.signal_def import SignalDefinition, SignalDefinitions

logger = logging.getLogger(__name__)


class AsyncTransport(Protocol):
    def __init__(self, signals: SignalDefinitions): ...

    async def connect(self): ...

    async def disconnect(self): ...

    @property
    def connected(self) -> bool: ...

    async def read(
        self,
        query: list[SignalDefinition],
    ) -> DecodedSignalValues | Exception: ...
