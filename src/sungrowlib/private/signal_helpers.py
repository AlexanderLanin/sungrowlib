import logging

from sungrowlib.types import DatapointBaseValueType, SignalDefinition, Supported

logger = logging.getLogger(__name__)


def get_supported_state_based_on_value(
    sigdef: SignalDefinition,
    value: DatapointBaseValueType,
    was_queried_individually: bool,
):
    if value is None:
        return Supported.NO

    if value != sigdef.value_with_no_meaning:
        return Supported.YES

    # Unknown, but which one?
    if was_queried_individually:
        return Supported.CONFIRMED_UNKNOWN
    else:
        return Supported.UNKNOWN_FROM_MULTI_SIGNAL_QUERY


def evaluate_signal_support(
    self: SignalDefinition, old_value: Supported, new_value: Supported
):
    assert new_value != Supported.NEVER_ATTEMPTED

    # Quick exit, if there is no change.
    if new_value == old_value:
        return old_value

    # Is it an "improvement" in knowledge?
    # E.g. when the signal was set to YES, but is now UNKNOWN, we want to keep the YES
    ranks = {
        Supported.NEVER_ATTEMPTED: 0,
        Supported.UNKNOWN_FROM_MULTI_SIGNAL_QUERY: 1,
        Supported.CONFIRMED_UNKNOWN: 2,
        Supported.YES: 3,
        Supported.NO: 3,
    }
    old_rank = ranks[old_value]
    new_rank = ranks[new_value]

    if new_rank < old_rank:
        return old_value
    else:
        # Log significant changes in support status
        if new_rank >= 3:
            if old_rank >= 3:
                logger.warning(
                    f"Signal {self.name} changed support status "
                    f"from {old_value} to {new_value}."
                )
            else:
                s = "supported" if new_value == Supported.YES else "not supported"
                logger.debug(f"Signal {self.name} is {s}.")
        return new_value
