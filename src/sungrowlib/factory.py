import logging
from dataclasses import dataclass
from enum import StrEnum

from sungrowlib.HttpTransport import HttpTransport
from sungrowlib.PymodbusTransport import PymodbusTransport

from .AsyncModbusClient import AsyncModbusClient, AsyncModbusTransport
from .signal_def import SignalDefinitions

logger = logging.getLogger(__name__)


class ConnectionMode(StrEnum):
    HTTP_WEBSOCKET = "http"
    MODBUS = "modbus"
    ANY = "any"


@dataclass
class ConnectionParams:
    host: str
    port: int | None
    mode: ConnectionMode | None


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
    if port == HttpTransport.default_port():
        return [
            ConnectionParams(
                host=host,
                port=port or HttpTransport.default_port(),
                mode=ConnectionMode.HTTP_WEBSOCKET,
            )
        ]

    elif port is not None:
        # Non http port can only mean modbus proxy
        return [ConnectionParams(host=host, port=port, mode=ConnectionMode.MODBUS)]

    else:
        first = None

    p1 = ConnectionParams(
        host=host,
        port=port or PymodbusTransport.default_port(),
        mode=ConnectionMode.MODBUS,
    )

    p2 = ConnectionParams(
        host=host,
        port=HttpTransport.default_port(),
        mode=ConnectionMode.HTTP_WEBSOCKET,
    )

    return [p1, p2] if first is None else [first, p1]


def _get_connection_cls(connection: ConnectionMode):
    if connection == ConnectionMode.HTTP_WEBSOCKET:
        return HttpTransport
    if connection == ConnectionMode.MODBUS:
        return PymodbusTransport
    raise ValueError(f"Unsupported connection mode: {connection}")


async def _connect(
    params: ConnectionParams,
    signals: SignalDefinitions | None = None,
) -> AsyncModbusTransport | None:
    assert params.mode and params.mode != ConnectionMode.ANY
    cls = _get_connection_cls(params.mode)
    transport = cls(params.host, params.port)

    logger.debug(f"Trying to connect to inverter using {params.mode} connection")
    if await transport.connect():
        logger.debug("Successfully connected to inverter")
        return transport


# TODO: move this to AsyncModbusClient.__init__?!!!??
async def create_async(
    host: str,
    port: int | None,
    mode: ConnectionMode = ConnectionMode.ANY,
    signals: SignalDefinitions | None = None,
) -> AsyncModbusClient | None:
    assert signals  # TODO

    connection_variants = _get_all_connection_variants(host, port, mode)
    for variant in connection_variants:
        assert variant.mode != ConnectionMode.ANY
        transport = await _connect(variant, signals)
        if transport:
            return AsyncModbusClient(transport, signals)
    return None
