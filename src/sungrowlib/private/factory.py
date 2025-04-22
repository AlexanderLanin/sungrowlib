import logging
from dataclasses import dataclass
from enum import StrEnum

from sungrowlib.AsyncModbusClient import CannotConnectError
from sungrowlib.transports import AsyncModbusTransport, HttpTransport, PymodbusTransport

logger = logging.getLogger(__name__)


class ConnectionMode(StrEnum):
    HTTP_WEBSOCKET = "http"
    MODBUS = "modbus"


@dataclass
class PartialConnectionParams:
    host: str
    port: int | None
    mode: ConnectionMode | None


@dataclass
class ResolvedConnectionParams:
    host: str
    port: int
    mode: ConnectionMode


def _assemble_connection_variants(
    params: PartialConnectionParams,
) -> list[ResolvedConnectionParams]:
    # If mode is already set, return the params as is
    if params.mode:
        cc = _get_connection_cls(params.mode)
        return [ResolvedConnectionParams(params.host, cc.default_port(), cc)]

    # If port looks like a http port, assume http connection
    if params.port == HttpTransport.default_port():
        return [
            ResolvedConnectionParams(
                host=params.host,
                port=params.port or HttpTransport.default_port(),
                mode=ConnectionMode.HTTP_WEBSOCKET,
            )
        ]

    elif params.port is not None:
        # Non http port can only mean modbus proxy
        return [
            ResolvedConnectionParams(
                host=params.host, port=params.port, mode=ConnectionMode.MODBUS
            )
        ]

    else:
        first = None

    p1 = ResolvedConnectionParams(
        host=params.host,
        port=params.port or PymodbusTransport.default_port(),
        mode=ConnectionMode.MODBUS,
    )

    p2 = ResolvedConnectionParams(
        host=params.host,
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


async def _connect_specific_transport(
    params: ResolvedConnectionParams,
) -> AsyncModbusTransport | None:
    cls = _get_connection_cls(params.mode)
    transport = cls(params.host, params.port)

    logger.debug(f"Trying to connect to inverter using {params.mode} connection")
    if await transport.connect():
        logger.debug("Successfully connected to inverter")
        return transport


async def initialize_transport(
    params: PartialConnectionParams,
):
    connection_variants = _assemble_connection_variants(params)
    for variant in connection_variants:
        transport = await _connect_specific_transport(variant)
        if transport:
            logger.debug(
                f"Successfully connected to inverter using {variant.mode} connection"
            )
            return transport
    else:
        raise CannotConnectError(
            f"Cannot connect to inverter using {params.mode} connection"
        )
