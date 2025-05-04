import logging
from dataclasses import dataclass
from enum import StrEnum

from sungrowlib.transports import AsyncModbusTransport, HttpTransport, PymodbusTransport
from sungrowlib.types import CannotConnectError

logger = logging.getLogger(__name__)


class ConnectionMode(StrEnum):
    HTTP = "http"
    MODBUS = "modbus"


@dataclass
class ConnectionParams:
    host: str
    port: int | None
    mode: ConnectionMode | None


@dataclass
class ResolvedConnectionParams:
    host: str
    port: int
    mode: ConnectionMode


def _assemble_connection_variants(
    params: ConnectionParams,
) -> list[ResolvedConnectionParams]:
    if params.mode:
        if params.port:
            return [ResolvedConnectionParams(params.host, params.port, params.mode)]
        else:
            cc = _get_connection_cls(params.mode)
            return [
                ResolvedConnectionParams(params.host, cc.default_port(), params.mode)
            ]

    # If port looks like a http port, assume http connection
    if params.port and params.port == HttpTransport.default_port():
        return [
            ResolvedConnectionParams(
                host=params.host,
                port=params.port,
                mode=ConnectionMode.HTTP,
            )
        ]

    # If port looks like a modbus port, assume modbus connection
    elif params.port and params.port is PymodbusTransport.default_port():
        return [
            ResolvedConnectionParams(
                host=params.host, port=params.port, mode=ConnectionMode.MODBUS
            )
        ]

    p1 = ResolvedConnectionParams(
        host=params.host,
        port=params.port or PymodbusTransport.default_port(),
        mode=ConnectionMode.MODBUS,
    )

    p2 = ResolvedConnectionParams(
        host=params.host,
        port=params.port or HttpTransport.default_port(),
        mode=ConnectionMode.HTTP,
    )

    # Let's try both connections
    # TODO: which one should be first?
    return [p1, p2]


def _get_connection_cls(connection: ConnectionMode):
    match connection:
        case ConnectionMode.HTTP:
            return HttpTransport
        case ConnectionMode.MODBUS:
            return PymodbusTransport


async def _connect_specific_transport(
    params: ResolvedConnectionParams,
) -> AsyncModbusTransport | None:
    cls = _get_connection_cls(params.mode)
    transport = cls(params.host, params.port)

    logger.debug(f"Trying to connect to inverter using {params.mode} connection")
    try:
        await transport.connect()
        logger.debug("Successfully connected to inverter")
        return transport
    except CannotConnectError:
        logger.debug("Failed to connect to inverter")
        return None


async def create_transport(
    params: ConnectionParams,
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
