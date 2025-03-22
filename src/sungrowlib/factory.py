import logging
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

from .clients.HttpTransport import AsyncHttpClient
from .clients.PymodbusTransport import PymodbusTransport
from .deserialization import DecodedSignalValues
from .signal_def import SignalDefinition, SignalDefinitions


class AsyncSungrowInverter(Protocol):
    def __init__(self, signals: SignalDefinitions): ...

    async def connect(self): ...

    async def disconnect(self): ...

    @staticmethod
    def default_port() -> int: ...

    @property
    def connected(self) -> bool:
        """
        Is the connection currently established?
        """
        ...

    async def read(
        self,
        query: list[SignalDefinition],
    ) -> DecodedSignalValues | Exception:
        """
        Note: this may return more signals than requested, as sometimes
        the query is optimized to read more than requested.
        """
        ...


logger = logging.getLogger(__name__)


class ConnectionMode(StrEnum):
    HTTP_WEBSOCKET = "http"
    MODBUS = "modbus"
    ANY = "any"


@dataclass
class ConnectionParams:
    host: str
    port: int | None
    client_class: AsyncSungrowInverter | None


def _get_all_connection_variants(
    host: str,
    port: int | None,
    mode: ConnectionMode = ConnectionMode.ANY,
) -> list[ConnectionParams]:
    # If mode is already set, return the params as is
    if mode != ConnectionMode.ANY:
        cc = _get_connection_cls(mode)
        return [ConnectionParams(host, cc.default_port(), cc)]

    # If port looks like a http port, assume http connection
    if params.port == AsyncHttpClient.default_port():
        return [
            ConnectionParams(
                host=params.host,
                port=params.port or AsyncHttpClient.default_port(),
                client_class=AsyncHttpClient,
            )
        ]

    elif params.port is not None:
        # Non http port can only mean modbus proxy
        return [
            ConnectionParams(
                host=params.host, port=params.port, mode=ConnectionMode.MODBUS
            )
        ]

    else:
        first = None

    p1 = ConnectionParams(
        host=params.host,
        port=params.port or PymodbusTransport.default_port(),
        client_class=PymodbusTransport,
    )

    p2 = ConnectionParams(
        host=params.host,
        port=ModbusConnection_Http.default_port(),
        client_class=AsyncHttpClient,
    )

    return [p1, p2] if first is None else [first, p1]


def _get_connection_cls(connection: ConnectionMode):
    return {
        ConnectionMode.HTTP_WEBSOCKET: AsyncHttpClient,
        ConnectionMode.MODBUS: PymodbusTransport,
    }[connection]


async def _connect(
    params: ConnectionParams,
    signals: SignalDefinitions | None = None,
) -> AsyncSungrowInverter | None:
    cls = params.client_class
    connection_obj = cls(params.host, params.port, signals)

    logger.debug(
        f"Trying to connect to inverter using {params.client_class} connection"
    )
    if await connection_obj.connect():
        logger.debug("Successfully connected to inverter")
        return connection_obj


async def create_async(
    host: str,
    port: int | None,
    mode: ConnectionMode = ConnectionMode.ANY,
    signals: SignalDefinitions | None = None,
) -> AsyncSungrowInverter | None:
    connection_variants = _get_all_connection_variants(
        ConnectionParams(host, port, _get_connection_cls(mode))
    )
    for variant in connection_variants:
        assert variant.client_class != ConnectionMode.ANY
        connection = await _connect(variant, signals)
        if connection:
            return connection
    return None
