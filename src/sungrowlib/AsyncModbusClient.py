import logging
from dataclasses import dataclass
from datetime import datetime
from typing import AsyncGenerator, Protocol

from result import Err, Ok, Result

from sungrowlib.deserialization import decode_signal
from sungrowlib.modbus_types import RawData
from sungrowlib.signal_def import (
    DatapointValueType,
    RegisterRange,
    RegisterType,
    SignalDefinition,
    SignalDefinitions,
)

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


def _generate_query_batches(
    signals: list[SignalDefinition],
    max_registers_per_range: int,
) -> list[tuple[RegisterRange, list[SignalDefinition]]]:
    """
    Split the list of signals into ranges.
    Each range is guaranteed to:
    - not exceed the max_registers_per_range
    - be sorted by address
    - only contain signals of the same register type
    """

    def can_add(cr: list[SignalDefinition], signal: SignalDefinition, max: int):
        return not cr or signal.registers.end - cr[0].registers.start <= max

    def sorted_and_filtered(
        signals: list[SignalDefinition], register_type: RegisterType
    ) -> list[SignalDefinition]:
        return sorted(
            filter(lambda s: s.registers.register_type == register_type, signals),
            key=lambda s: s.registers.start,
        )

    def range_and_signals(signals: list[SignalDefinition]):
        if not signals:
            raise ValueError("current_range is empty")
        return RegisterRange(
            signals[0].registers.register_type,
            signals[0].registers.start,
            signals[-1].registers.end - signals[0].registers.start,
        ), signals

    # We need to build the ranges for read and hold separately, as they can't be
    # mixed/combined.
    ranges: list[tuple[RegisterRange, list[SignalDefinition]]] = []

    for register_type in RegisterType:
        current_range: list[SignalDefinition] = []

        for signal in sorted_and_filtered(signals, register_type):
            if can_add(current_range, signal, max_registers_per_range):
                current_range.append(signal)
            else:
                ranges.append(range_and_signals(current_range))
                current_range = [signal]

        if current_range:
            ranges.append(range_and_signals(current_range))

    return ranges


def _extract_signal_value_from_raw(r: RawData, signal: SignalDefinition):
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


class AsyncModbusClient:  # noqa: N801
    """A pymodbus connection to a single slave."""

    @dataclass
    class Stats:
        connections: int = 0
        read_calls_success: int = 0
        read_calls_failed: int = 0
        retrieved_signals_success: int = 0
        retrieved_signals_failed: int = 0

    def __init__(self, transport: AsyncModbusTransport, all_signals: SignalDefinitions):
        self._transport = transport
        self._stats = AsyncModbusClient.Stats()
        self._all_signals = all_signals

    @property
    def stats(self):
        return self._stats

    async def connect(self) -> bool:
        return await self._transport.connect()

    async def disconnect(self) -> None:
        await self._transport.disconnect()

    @property
    def connected(self):
        return self._transport.connected

    async def read(
        self, signals: list[SignalDefinition]
    ) -> AsyncGenerator[tuple[SignalDefinition, DatapointValueType], None]:
        """Pull data from inverter"""

        async for signal, raw_value in self._read_raw(signals):
            yield (signal, decode_signal(signal, raw_value) if raw_value else None)

    async def _read_raw(
        self,
        query: list[SignalDefinition],
        max_combined_registers=100,
    ) -> AsyncGenerator[tuple[SignalDefinition, list[int] | None], None]:
        """
        Note: may return MORE signals than requested, as sometimes
        the query is optimized to read more than requested.

        Will RAISE an exception if the connection fails.
        """

        pull_start = datetime.now()

        if not await self.connect():
            raise CannotConnectError("Cannot connect to inverter for reading")

        # We cannot query all signals at once, as the inverter will not respond.
        # So we split the signals into ranges and query each range separately.
        # Build as few ranges as possible:
        query_batches = _generate_query_batches(query, max_combined_registers)

        if len(query_batches) > 1 or len(query) > 5:
            logger.debug(
                f"read_raw({len(query)} signals) in {len(query_batches)} ranges"
            )
        else:
            logger.debug(f"read_raw(single range: {[s.name for s in query]})")

        for query_range, query_batch in query_batches:
            raw = (await self._read_range(query_range)).expect("Failed to read range")

            # query_range may contain more signals than query_batch, as some signals
            # may be queried by accident due to generation of query ranges.
            all_signals_in_query_range = (
                self._all_signals.get_all_signals_contained_in_registers(query_range)
            )
            for s in all_signals_in_query_range:
                if s not in query_batch:
                    # Let's see how often this happens... TODO
                    logger.warning(f"Signal {s.name} queried, but not in query")

                elapsed = datetime.now() - pull_start
                logger.debug(
                    f"Inverter: Pulled signal in {elapsed.seconds}.{elapsed.microseconds} secs"
                )

                yield (s, _extract_signal_value_from_raw(raw, s))

        elapsed = datetime.now() - pull_start
        logger.debug(
            f"Inverter: pull of {len(query)} signals in "
            f"{elapsed.seconds}.{elapsed.microseconds} secs, but was interrupted"
        )

    async def __aenter__(self):
        """Called on 'async with' enter."""
        if not await self._transport.connect():
            raise CannotConnectError("Cannot connect to inverter")
        return self

    async def __aexit__(self, exc_type, exc_value, traceback):
        """Called on 'async with' exit."""
        await self._transport.disconnect()

    async def _read_range(self, r: RegisterRange) -> Result[RawData, Exception]:
        """
        Returns None for unsupported registers.
        """
        res = await self._transport.read_range(r)
        if isinstance(res, Ok):
            self._stats.read_calls_success += 1
            raw_dict: RawData = {
                r.start + i: value for i, value in enumerate(res.ok_value)
            }
            return Ok(raw_dict)
        elif isinstance(res.err_value, UnsupportedRegisterQueriedError):
            # All signals have failed, but we indicate this by success, since we have
            # successfully read the range and determined this information.
            self.stats.retrieved_signals_success += 1
            return Ok(dict.fromkeys(range(r.start, r.end)))
        else:
            self._stats.read_calls_failed += 1
            return Err(res.err_value)
