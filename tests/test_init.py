import pytest
from attr import dataclass
from simulation import simulate_modbus_inverter

from sungrowlib import (
    AsyncModbusTransport,
    ConnectionError,
    ConnectionMode,
    ConnectionParams,
    SungrowClient,
)


@dataclass
class ModbusServer:
    port: int


@pytest.fixture
async def modbus_server():
    async with simulate_modbus_inverter(None) as port:
        yield ModbusServer(port=port)


async def verify_connection(
    transport_or_params: ConnectionParams | AsyncModbusTransport,
):
    client = await SungrowClient.create(
        transport_or_params,
        None,
    )
    assert client.connected is True
    await client.disconnect()


async def test_connect_modbus(modbus_server: ModbusServer):
    await verify_connection(
        ConnectionParams("localhost", modbus_server.port, ConnectionMode.MODBUS),
    )


async def test_connect_http_fails(modbus_server: ModbusServer):
    with pytest.raises(ConnectionError):
        await verify_connection(
            ConnectionParams("localhost", modbus_server.port, ConnectionMode.HTTP),
        )


async def test_connect_via_modbus_by_default(modbus_server: ModbusServer):
    await verify_connection(
        ConnectionParams("localhost", modbus_server.port, None),
    )
