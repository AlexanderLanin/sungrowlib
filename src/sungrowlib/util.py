from typing import TypeVar

from sungrowlib.types import InvalidResponseError

T = TypeVar("T")
E = TypeVar("E", bound=Exception)


def typesafe_get(
    value: dict[str, object],
    key: str,
    expected_type: type[T],
    exception: type[E] = InvalidResponseError,
):
    """
    Safely get a key from a dictionary:
    * If the key is not found or the value is not of the expected type, it will return None.
    """

    if not isinstance(value, dict):  # type: ignore[unreachable] - the point of this function is to check if the value is really a dict
        raise exception(f"Expected a dictionary, but got {type(value).__name__}")

    if key not in value:
        raise exception(f"Key '{key}' not found in the dictionary")

    val: object = value.get(key)
    if not isinstance(val, expected_type):
        raise exception(
            f"Value for key '{key}' is not of type {expected_type.__name__}"
        )

    return val
