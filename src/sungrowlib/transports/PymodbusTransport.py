"""
A convinience wrapper for pymodbus.
"""

import asyncio
import contextlib
import logging
from datetime import datetime, timedelta

import pymodbus
import pymodbus.client
import pymodbus.exceptions
import pymodbus.framer.base
import pymodbus.pdu
from result import Err, Ok, Result

from sungrowlib.AsyncModbusClient import (
    CannotConnectError,
    GenericError,
    InvalidSlaveError,
    UnsupportedRegisterQueriedError,
)
from sungrowlib.types import RegisterRange, RegisterType

logger = logging.getLogger(__name__)


# if pymodbus.__version__ != "3.6.8":
#     raise RuntimeError("This fix needs to be adjusted")

# # WiNet-S responds with slightly incorrect message headers in case of errors.
# # Version: M_WiNet-S_V01_V01_A
# # Pymodbus will trigger a needless TCP reconnect, and it will report "no message
# # received". While we can deal with the latter, the former is a bit more annoying.
# # The root cause is WiNet transmits 3 bytes of data, but reports to transmit 2.
# # As we know what exactly is wrong with the message, we simply need to fix the header
# # length before pymodbus tries to decode it.
# # pymodbus 3.6.6 has a function named _validate_slave_id which is called just at the
# # right time to fix the message header. We don't particularly care about what it
# # actually does, as we can simply inject our fix right before it is called:
# def inject_message_header_fix():
#     if pymodbus.__version__ != "3.6.6":
#         raise RuntimeError("This fix needs to be adjusted")

#     real_validate_slave_id = pymodbus.framer.base.ModbusFramer._validate_slave_id

#     def injected(self, a, b):
#         if self._buffer[self._hsize] & 0x80 and self._header["len"] == 2:
#             self._header["len"] = 3
#         return real_validate_slave_id(self, a, b)

#     pymodbus.framer.base.ModbusFramer._validate_slave_id = injected  # type: ignore


# inject_message_header_fix()


async def __call_pymodbus_client_read(
    client: pymodbus.client.ModbusBaseClient,
    slave: int,
    register_range: RegisterRange,
) -> Result[list[int], Exception]:
    """Low level pymodbus abstraction, mostly for error handling."""

    read_registers = {
        RegisterType.READ: client.read_input_registers,
        RegisterType.HOLD: client.read_holding_registers,
    }[register_range.register_type]
    try:
        # Note: sending_address = protocol_address - 1.
        rr: pymodbus.pdu.ModbusPDU = await read_registers(
            register_range.start - 1, count=register_range.length, slave=slave
        )
    except pymodbus.exceptions.ConnectionException as e:
        return Err(CannotConnectError(f"{type(e).__name__}: {e}"))
    except pymodbus.exceptions.ModbusIOException as e:
        return Err(
            GenericError(f"Unknown IO Error in pymodbus: {type(e).__name__}: {e}")
        )
    except Exception as e:
        return Err(GenericError(f"Unknown error in pymodbus: {type(e).__name__}: {e}"))

    if rr.isError():
        if isinstance(rr, pymodbus.pdu.ExceptionResponse):
            if rr.exception_code == pymodbus.pdu.ExceptionResponse.GATEWAY_NO_RESPONSE:
                return Err(InvalidSlaveError(f"Slave ID {slave} is invalid"))
            elif rr.exception_code == pymodbus.pdu.ExceptionResponse.ILLEGAL_ADDRESS:
                return Err(
                    UnsupportedRegisterQueriedError(
                        f"Inverter does not support {register_range}: {rr}"
                    )
                )
            else:
                logger.warning(
                    "Unexpected error response: %s. Please inform the developer.", rr
                )
                return Err(GenericError(f"Error response code: {rr.exception_code}"))
        else:
            return Err(GenericError(f"Unknown error response: {rr}"))

    if len(rr.registers) != register_range.length:
        return Err(
            GenericError(
                f"Mismatched number of registers "
                f"(requested {register_range}) and responded {len(rr.registers)})"
            )
        )

    return Ok(rr.registers)


class PymodbusTransport:  # noqa: N801
    """
    Transport layer for pymodbus.

    Note: multiple slaves are currently not supported.
    """

    def __init__(self, host: str, port: int | None):
        if not port:
            port = self.default_port()

        self._repr = f"{host}:{port}"

        self._client = pymodbus.client.AsyncModbusTcpClient(
            host=host, port=port, timeout=2, retries=2
        )

        self._next_allowed_call = datetime.min
        self._slave: int | None = None

    @staticmethod
    def default_port() -> int:
        return 502

    @property
    def slave(self):
        return self._slave

    @slave.setter
    def slave(self, value: int):
        logger.debug(f"Setting slave to {value}")
        self._slave = value

    def _debug(self, msg: str):
        logger.debug(f"{self._repr}: {msg}")

    # Move to TransportBase ABC class?
    async def _add_delay_between_API_calls(self):
        MIN_DELAY = timedelta(seconds=2)

        now = datetime.now()
        if now < self._next_allowed_call:
            delay = self._next_allowed_call - now
            await asyncio.sleep(delay.total_seconds())
        self._next_allowed_call = datetime.now() + MIN_DELAY

    async def connect(self):
        if self._client.connected:
            return True
        else:
            self._debug("Connecting...")
            await self._add_delay_between_API_calls()
            result = await self._client.connect()
            if result:
                logger.debug("Connected")
            else:
                logger.debug("Failed to connect")
            return result

    async def disconnect(self):
        # The _client has a 'reconnect_task' which it will cancel and delete on close().
        # So we beed to fetch it before closing the connection.
        logger.debug("Disconnecting...")
        reconnect_task = self._client.reconnect_task  # type: ignore
        await self._add_delay_between_API_calls()
        self._client.close()
        if reconnect_task:
            # Catch CancelledError, as this is expected.
            with contextlib.suppress(asyncio.CancelledError):
                await reconnect_task
        logger.debug("Disconnected")

    @property
    def connected(self) -> bool:
        return self._client.connected

    async def read_range(
        self,
        register_range: RegisterRange,
    ) -> Result[
        list[int], CannotConnectError | GenericError | UnsupportedRegisterQueriedError
    ]:
        """
        Reads `address_count` registers of type `register_type` starting at
        `address_start`.
        Note: each register is 16 bits, so `address_count` is the number of registers,
        not bytes.
        """
        assert self._slave is not None, "Slave ID must be set before reading"  # TODO

        self._debug(f"read_range({register_range=})...")
        if not await self.connect():
            return Err(CannotConnectError("Cannot connect to inverter for reading"))

        return await __call_pymodbus_client_read(
            self._client, self._slave, register_range
        )

    def __str__(self):
        return f"modbus({self._repr}, slave: {self._slave or 'unknown'})"
