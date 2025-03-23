from typing import Any, TypeVar, overload

from result import Err, Ok

_get_key__Tval = TypeVar("_get_key__Tval")
_get_key__Terr = TypeVar("_get_key__Terr")


@overload
def get_key(
    value: Ok[dict[str, Any]], key: str, expected_type: type[_get_key__Tval]
) -> Ok[_get_key__Tval] | None: ...


@overload
def get_key(
    value: Err[_get_key__Terr], key: str, expected_type: type
) -> Err[_get_key__Terr]: ...


@overload
def get_key(
    value: dict[str, Any], key: str, expected_type: type[_get_key__Tval]
) -> _get_key__Tval | None: ...


def get_key(
    value: dict[str, Any] | Ok[dict[str, Any]] | Err[_get_key__Terr],
    key: str,
    expected_type: type[_get_key__Tval],
) -> Err[_get_key__Terr] | Ok[_get_key__Tval] | _get_key__Tval | None:
    """
    Safely get a key from a dictionary:
    * If value is an instance of `Ok`, it will return an `Ok` instance.
    * If value is an instance of `Err`, it will return the original value.
    * If the key is not found or the value is not of the expected type, it will return None.
    """

    if isinstance(value, Err):
        return value
    is_ok = isinstance(value, Ok)
    if is_ok:
        value = value.ok_value
    if isinstance(value, dict):
        val = value.get(key)
        if isinstance(val, expected_type):
            if is_ok:
                return Ok(val)
            return val
    return None
