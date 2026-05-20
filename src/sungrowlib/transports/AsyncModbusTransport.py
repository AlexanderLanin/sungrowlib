from typing import Protocol

from sungrowlib.types import RegisterRange


class AsyncModbusTransport(Protocol):
    async def connect(self) -> None:
        """Throws a ConnectionError if the connection cannot be established."""
        ...

    async def disconnect(self) -> None: ...

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
    ) -> list[int]:
        """
        Note: this may return more signals than requested, as sometimes
        the query is optimized to read more than requested.

        Can throw an GenericError or a subclass of it.
        """
        ...
