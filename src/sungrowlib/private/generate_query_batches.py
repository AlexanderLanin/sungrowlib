from sungrowlib.types import (
    RegisterRange,
    RegisterType,
    SignalDefinition,
)


def generate_query_batches(
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
