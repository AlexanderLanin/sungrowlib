from typing import Protocol

from result import Result

from sungrowlib.types import (
    RegisterRange,
    SignalDefinitions,
)


class AsyncModbusTransport(Protocol):
    def __init__(self, signals: SignalDefinitions): ...

    async def connect(self) -> bool: ...

    async def disconnect(self): ...

    @staticmethod
    def default_port() -> int: ...

    @property
    def connected(self) -> bool:
        """
        Is the connection currently established?
        """
        ...

    async def read_range(
        self,
        register_range: RegisterRange,
    ) -> Result[list[int], Exception]:
        """
        Note: this may return more signals than requested, as sometimes
        the query is optimized to read more than requested.
        """
        ...
