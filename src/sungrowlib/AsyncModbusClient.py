import logging
from dataclasses import dataclass
from datetime import datetime
from typing import AsyncGenerator

from sungrowlib.private.deserialization import (
    decode_signal,
    extract_signal_value_from_raw,
)
from sungrowlib.private.generate_query_batches import generate_query_batches
from sungrowlib.transports import (
    AsyncModbusTransport,
    ConnectionParams,
    create_transport,
)
from sungrowlib.types import (
    CannotConnectError,
    DatapointValueType,
    GenericError,
    RawData,
    RegisterRange,
    SignalDefinition,
    SignalDefinitions,
    UnsupportedRegisterQueriedError,
)

logger = logging.getLogger(__name__)


class SungrowClient:
    """A pymodbus connection to a single slave."""

    @dataclass
    class Stats:
        connections: int = 0
        read_calls_success: int = 0
        read_calls_failed: int = 0
        retrieved_signals_success: int = 0
        retrieved_signals_failed: int = 0

    def __init__(
        self,
        transport: AsyncModbusTransport,
        all_signals: SignalDefinitions | None,
    ) -> None:
        """
        If you provide all_signals, the client will report 'accidentally' queried signals
        that are not in the query.
        """
        self._transport = transport
        self._stats = SungrowClient.Stats()
        self._all_signals = all_signals

    @staticmethod
    async def create(
        transport_or_params: AsyncModbusTransport | ConnectionParams,
        all_signals: SignalDefinitions | None,
    ) -> "SungrowClient":
        """
        If you provide all_signals, the client will report 'accidentally' queried signals
        that are not in the query.
        """
        if isinstance(transport_or_params, ConnectionParams):
            transport = await create_transport(transport_or_params)
        else:
            transport = transport_or_params

        return SungrowClient(transport, all_signals)

    @property
    def stats(self):
        return self._stats

    async def connect(self) -> None:
        await self._transport.connect()

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
        max_combined_registers: int = 100,
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
        query_batches = generate_query_batches(query, max_combined_registers)

        if len(query_batches) > 1 or len(query) > 5:
            logger.debug(
                f"read_raw({len(query)} signals) in {len(query_batches)} ranges"
            )
        else:
            logger.debug(f"read_raw(single range: {[s.name for s in query]})")

        for query_range, query_batch in query_batches:
            raw = await self._read_range(query_range)

            # query_range may contain more signals than query_batch, as some signals
            # may be queried by accident due to generation of query ranges.
            if self._all_signals:
                all_signals_in_query_range = (
                    self._all_signals.get_all_signals_contained_in_registers(
                        query_range
                    )
                )
            else:
                all_signals_in_query_range = query_batch
            for s in all_signals_in_query_range:
                if s not in query_batch:
                    # Let's see how often this happens... TODO
                    logger.warning(f"Signal {s.name} queried, but not in query")

                elapsed = datetime.now() - pull_start
                logger.debug(
                    f"Inverter: Pulled signal in {elapsed.seconds}.{elapsed.microseconds} secs"
                )

                yield (s, extract_signal_value_from_raw(raw, s))

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

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: object | None,
    ) -> None:
        """Called on 'async with' exit."""
        await self._transport.disconnect()

    async def _read_range(self, r: RegisterRange) -> RawData:
        """
        Returns None for unsupported registers.
        """
        try:
            res = await self._transport.read_range(r)
            self._stats.read_calls_success += 1
            return {r.start + i: value for i, value in enumerate(res)}
        except UnsupportedRegisterQueriedError:
            # All signals have failed, but we indicate this by success, since we have
            # successfully read the range and determined this information.
            self.stats.retrieved_signals_success += 1
            return dict.fromkeys(range(r.start, r.end))
        except GenericError:
            self._stats.read_calls_failed += 1
            raise
