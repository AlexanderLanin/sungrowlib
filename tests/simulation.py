import asyncio
import logging
import pathlib
from _asyncio import Task
from contextlib import asynccontextmanager, contextmanager, suppress
from dataclasses import dataclass
from typing import cast

import pymodbus.datastore
import pymodbus.datastore.store
import pymodbus.server

# import pytest_socket  # pyright: ignore[reportMissingTypeStubs]
import yaml
from pymodbus.server.server import ModbusTcpServer

logger = logging.getLogger(__name__)

# Note: pytest_socket will block all socket calls by default.
# To allow socket calls, you need to use the `enable_socket` context manager.

TEST_DATA = pathlib.Path(__file__).parent / "test_data"


def _build_modbus_context_from_yaml(yaml_file: str | pathlib.Path | None):
    response_data = pymodbus.datastore.ModbusSlaveContext()

    if yaml_file:
        pymodbus_stores = {
            "read": "i",
            "hold": "h",
        }

        if isinstance(yaml_file, str):
            yaml_file = TEST_DATA / yaml_file

        with open(yaml_file) as f:
            yaml_data = yaml.safe_load(f)
            # some old yaml recordings don't have the "registers" key
            if "registers" in yaml_data:
                yaml_data = yaml_data["registers"]
            for register_type, registers in yaml_data.items():
                stores = cast(
                    dict[str, pymodbus.datastore.store.ModbusSequentialDataBlock],
                    response_data.store,
                )
                store = stores[pymodbus_stores[register_type]]
                for address, value in registers.items():
                    store.setValues(address, [value])  # pyright: ignore[reportUnknownMemberType]

        return pymodbus.datastore.ModbusServerContext(
            slaves={1: response_data}, single=False
        )
    else:
        # no response
        return pymodbus.datastore.ModbusServerContext(single=False)


@contextmanager
def enable_socket(ip: str):
    """
    Temporarily enable sockets for the given IP address.
    """
    # Block connect() to all hosts except localhost
    # pytest_socket.socket_allow_hosts(ip)  # pyright: ignore[reportUnknownMemberType]
    # Restore sockets in general
    # pytest_socket.enable_socket()

    yield

    # Re-Disable sockets after the test case
    # pytest_socket.disable_socket()


@dataclass
class RunningServer:
    server: ModbusTcpServer
    server_task: Task[None]
    port: int


async def start_modbus_tcp_server(
    context: pymodbus.datastore.ModbusServerContext,
):
    server = pymodbus.server.ModbusTcpServer(context=context, address=("0.0.0.0", 0))

    # Run server in background task.
    server_task = asyncio.create_task(server.serve_forever())

    # Wait for server to actually start.
    for attempt in range(20):  # noqa: B007
        if server.transport:
            break
        await asyncio.sleep(0.1)
    else:
        raise Exception("Server failed to start.")
    if attempt > 1:
        logger.warning(f"Server start took {attempt / 10} seconds.")
    port = cast(int, server.transport.sockets[0].getsockname()[1])  # pyright: ignore[reportUnknownMemberType, reportAttributeAccessIssue]
    logger.debug(f"Server started on port {port}")
    assert port

    return RunningServer(server, server_task, port)


async def stop_modbus_tcp_server(data: RunningServer):
    await data.server.shutdown()
    await data.server.serving  # pyright: ignore[reportUnknownMemberType]
    data.server_task.cancel()
    with suppress(asyncio.CancelledError):
        await data.server_task


@asynccontextmanager
async def simulate_modbus_inverter(yaml_file: str | pathlib.Path | None):
    """
    Simulate a Sungrow inverter by running a Modbus server with a response context
    based on the given yaml file.
    """

    context = _build_modbus_context_from_yaml(yaml_file)

    with enable_socket("localhost"):
        data = await start_modbus_tcp_server(context)
        yield data.port
        await stop_modbus_tcp_server(data)
