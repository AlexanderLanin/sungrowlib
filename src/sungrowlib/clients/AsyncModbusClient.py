"""
The abstraction level is chosen so signals are read() at once, and all modbus
optimizations/limitations are handled within this class.
Basically it's pure modbus, with a (hopefully) better interface.
"""

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import cast

from result import Err, Ok, Result

import sungrowlib.modbus_types
from sungrowlib.modbus_types import (
    MappedData,
    RawData,
)
from sungrowlib.signal_def import (
    DatapointBaseValueType,
    DatapointValueType,
    RegisterRange,
    RegisterType,
    SignalDefinition,
)

from .connection_base import (
    Connection,
    DecodedSignalValues,
)
from .transport import ModbusTransport

logger = logging.getLogger(__name__)


class ModbusError(Exception):
    """Generic error for all modbus related errors."""


class InvalidSlaveError(ModbusError):
    pass


class CannotConnectError(ModbusError):
    pass


class ConnectionError(Err):
    def __init__(self):
        super().__init__("Some problem with the connection")


class BusyError(Err):
    def __init__(self):
        super().__init__("Inverter is busy, please try again later")


class UnsupportedRegisterQueriedError(ModbusError):
    """
    WiNet: ALL queried registers are unsupported.

    Note: this exception is raised by implementations of ModbusConnectionBase, but it's
    never forwared to the user. Instead, the implementation will return None for the
    unsupported registers.
    """


def sorted_and_filtered(
    signals: list[SignalDefinition], register_type: RegisterType
) -> list[SignalDefinition]:
    return sorted(
        filter(lambda s: s.registers.register_type == register_type, signals),
        key=lambda s: s.registers.start,
    )


def can_add(
    current_range: list[SignalDefinition],
    signal: SignalDefinition,
    max_registers_per_range: int,
    blocked_registers: list[int],
) -> bool:
    """Check if the signal can be added to the current range."""
    if not current_range:
        return True

    if (
        signal.registers.end - current_range[0].registers.start
        > max_registers_per_range
    ):
        return False

    # TODO: idea: add "ever_received" to each signal, only merge if ever received.
    # FIXME: hier merge verhalten! blocked_registers kann weg?!
    anything_blocked = any(
        addr in blocked_registers
        for addr in range(current_range[-1].registers.end, signal.registers.start)
    )

    return not anything_blocked


def _build_ranges(
    register_type: RegisterType,
    signals: list[SignalDefinition],
    max_registers_per_range: int,
    blocked_registers: list[int],
) -> list[list[SignalDefinition]]:
    ranges: list[list[SignalDefinition]] = []

    current_range: list[SignalDefinition] = []

    for signal in sorted_and_filtered(signals, register_type):
        if can_add(current_range, signal, max_registers_per_range, blocked_registers):
            current_range.append(signal)
        else:
            ranges.append(current_range)
            current_range = [signal]

    if current_range:
        ranges.append(current_range)

    return ranges


def split_list(
    signals: list[SignalDefinition],
    max_registers_per_range: int,
    blocked_registers: dict[RegisterType, list[int]] | None = None,
) -> list[list[SignalDefinition]]:
    # FIXME: only combine signals that are supported.
    # Or maybe those that are not unsupported?
    """
    Split the list of signals into ranges.
    Each range is guaranteed to:
    - not contain any blocked registers
    - not exceed the max_registers_per_range
    - be sorted by address
    - only contain signals of the same register type
    """
    # We need to build the ranges for read and hold separately, as they can't be
    # mixed/combined.
    return [
        *_build_ranges(
            RegisterType.READ,
            signals,
            max_registers_per_range,
            blocked_registers[RegisterType.READ] if blocked_registers else [],
        ),
        *_build_ranges(
            RegisterType.HOLD,
            signals,
            max_registers_per_range,
            blocked_registers[RegisterType.HOLD] if blocked_registers else [],
        ),
    ]


def _map_raw_to_signal(r: RawData, signal: SignalDefinition):
    # We'll use the first register to check if signal is supported.
    if r[signal.registers.start] is None:
        return None
    else:
        result: list[int] = []
        for i in range(signal.registers.length):
            v = r[signal.registers.start + i]
            # This can never happen, as there is just no way for a None to appear
            # in the middle of a range.
            # Ranges are cut at signal borders.
            # Each signal is either fully supported or not at all.
            assert v is not None
            result.append(v)
        return result


def _map_raw_to_signals(
    raw_data: dict[RegisterType, RawData], signal_list: list[SignalDefinition]
) -> MappedData:
    """
    Note: While this doesn't sound like it belongs into this class,
    it's usually also not intended to be called directly, but by read().
    But for some less common use cases it might be useful to call this directly
    """
    return {
        signal.name: _map_raw_to_signal(
            raw_data[signal.registers.register_type], signal
        )
        for signal in signal_list
    }


class AsyncModbusClient:  # noqa: N801
    """A pymodbus connection to a single slave."""

    @dataclass
    class Stats:
        connections: int = 0
        read_calls_success: int = 0
        read_calls_failed: int = 0
        retrieved_signals_success: int = 0
        retrieved_signals_failed: int = 0

    def __init__(self, transport: ModbusTransport):
        self._transport = transport
        self._stats = AsyncModbusClient.Stats()
        self._slave: int | None = None

    @property
    def stats(self):
        return self._stats

    # Should be optional since we have the Protocol class?!

    async def connect(self) -> bool:
        return await self._transport.connect()

    async def disconnect(self) -> None:
        await self._transport.disconnect()

    @property
    def connected(self):
        return self._transport.connected

    async def read(
        self, query: list[SignalDefinition]
    ) -> Result[DecodedSignalValues, Exception]:
        """Pull data from inverter"""

        pull_start = datetime.now()
        raw_data_result = await self._read_raw_while_handling_disconnects(query)
        elapsed = datetime.now() - pull_start

        if isinstance(raw_data_result, Ok):
            raw_data = raw_data_result.ok_value

            logger.debug(
                f"Inverter: Pulled {len(raw_data)}/{len(query)} signals in "
                f"{elapsed.seconds}.{elapsed.microseconds} secs"
            )

            decoded = decode_signals(
                query,
                raw_data,
            )
            return Ok(decoded)
        else:
            logger.debug(
                f"Inverter: Partial pull of {len(query)} signals in "
                f"{elapsed.seconds}.{elapsed.microseconds} secs, but was interrupted"
            )

            return raw_data_result

    ## -- DETAILED IMPLEMENTATION --

    async def _read_raw_while_handling_disconnects(
        self,
        signal_list: list[SignalDefinition],
        max_combined_registers=100,
        attempts=4,
    ) -> Result[MappedData, Exception]:
        res = await self._read_raw(signal_list, max_combined_registers)
        if isinstance(res, Ok):
            return Ok(_map_raw_to_signals(res.ok_value, signal_list))
        elif (
            isinstance(res.err_value, CannotConnectError)
            and attempts > 1
            and await self.connect()
        ):
            # FIXME!! Each attempt starts from scratch, but we should continue where we
            # left off.
            return await self._read_raw_while_handling_disconnects(
                signal_list, max_combined_registers, attempts - 1
            )
        else:
            return res

    async def _read_raw(
        self, signal_list: list[SignalDefinition], max_combined_registers=100
    ) -> Result[dict[RegisterType, RawData], Exception]:
        if not await self.connect():
            raise CannotConnectError("Not connected to inverter, but read() was called")

        # We cannot query all signals at once, as the inverter will not respond.
        # So we split the signals into ranges and query each range separately.
        # Build as few ranges as possible:
        ranges = split_list(signal_list, max_combined_registers)

        if len(ranges) > 1 or len(signal_list) > 5:
            logger.debug(
                f"read_raw({len(signal_list)} signals) in {len(ranges)} ranges"
            )
        else:
            logger.debug(f"read_raw({[s.name for s in signal_list]})")

        # Read each range
        raw_data: dict[RegisterType, RawData] = {r: {} for r in RegisterType}
        for signal_list in ranges:
            res = await self._read_range_base(signal_list)
            if isinstance(res, Ok):
                raw_data[signal_list[0].registers.register_type].update(res.ok_value)
            else:
                return Err(res.err_value)

        return Ok(raw_data)

    async def __aenter__(self):
        """Called on 'async with' enter."""
        logger.debug(f"__aenter__({self._host}, {self._port}, {self._slave})")
        if not await self.connect():
            raise CannotConnectError("Cannot connect to inverter")
        return self

    async def __aexit__(self, exc_type, exc_value, traceback):
        """Called on 'async with' exit."""
        logger.debug(f"__aexit__({self._host}, {self._port}, {self._slave})")
        await self.disconnect()

    async def _call_read_raw(self, r: RegisterRange) -> Result[RawData, Exception]:
        """Wrapper for _read_range() that returns RawData."""
        # logger.debug(f"_call_read_raw({r})")

        # _read_range() is implemented by the subclass.
        # It's returning a list of registers, so we need to map it.
        res = await self._read_range(r)
        if isinstance(res, Ok):
            self._stats.read_calls_success += 1
            raw_dict: RawData = {
                r.start + i: value for i, value in enumerate(res.ok_value)
            }
            return Ok(raw_dict)
        else:
            self._stats.read_calls_failed += 1
            return Err(res.err_value)

    async def _read_range_base(
        self, signal_list: list[SignalDefinition]
    ) -> Result[RawData, Exception]:
        """
        Wrapper for _read_range() that handles unsupported registers.
        Returns None for unsupported registers.
        """
        assert signal_list

        reg_range = RegisterRange(
            signal_list[0].registers.register_type,
            signal_list[0].registers.start,
            signal_list[-1].registers.end - signal_list[0].registers.start,
        )

        # Query entire range
        res = await self._call_read_raw(reg_range)
        if isinstance(res, Ok):
            self.stats.retrieved_signals_success += len(signal_list)

            # # On this level, we cannot determine if a signal is truly supported,
            # # or if it contains a default value with no meaning.
            # for signal in signal_list:
            #     if signal.is_supported == Signal.Supported.NEVER_ATTEMPTED:
            #         signal.set_supported(Signal.Supported.UNKNOWN)

            return Ok(res.ok_value)
        elif isinstance(res.err_value, UnsupportedRegisterQueriedError):
            # All signals have failed, but we indicate this by success, since we have
            # successfully read the range and determined this information.
            self.stats.retrieved_signals_success += len(signal_list)
            # All registers in this range are unsupported.
            return Ok(dict.fromkeys(range(reg_range.start, reg_range.end)))
        else:
            self.stats.retrieved_signals_failed += len(signal_list)
            return Err(res.err_value)

    async def _read_range(self, rr: RegisterRange) -> Result[list[int], Exception]:
        """
        Reads `address_count` registers of type `register_type` starting at
        `address_start`.
        Note: each register is 16 bits, so `address_count` is the number of registers,
        not bytes.
        """
        raise NotImplementedError
