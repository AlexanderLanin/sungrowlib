"""
WiNet HTTP connection for Sungrow inverters.

In detail this will query the inverter via websocket for the token and then
query the inverter via http for the actual data.

Data-queries via websocket are not yet implemented.
"""

import asyncio
import logging
import os
import time
from enum import Enum
from typing import TypeVar, cast

import aiohttp

from sungrowlib.types import (
    ConnectionError,
    GenericError,
    InvalidResponseError,
    RegisterRange,
    RegisterType,
    SungrowlibRuntimeError,
)
from sungrowlib.util import typesafe_get

logger = logging.getLogger(__name__)


T = TypeVar("T")


class HttpTransport:
    def __init__(self, host: str, port: int | None = None):
        if not port:
            port = self.default_port()
        self._host = host
        self._port = port

        # TODO: document why we keep an aiohttp.ClientSession around
        timeout = aiohttp.ClientTimeout(total=10)
        self._aio_client = aiohttp.ClientSession(timeout=timeout)
        self._ws: aiohttp.client.ClientWebSocketResponse | None = None

        self._token: str | None = None
        self._inverter: dict[str, str] | None = None

    @staticmethod
    def default_port() -> int:
        return 8082

    async def _ws_query(
        self, query: dict[str, str | int], return_key: str, return_type: type[T]
    ) -> T:
        # Potential services: connect, devicelist, state, statistics, runtime, real
        if self._ws is None:
            raise SungrowlibRuntimeError("Websocket not connected")

        try:
            await self._ws.send_json(query)
            response: dict[str, object] = await self._ws.receive_json()
        except Exception as e:
            logger.error(f"Cannot send message to inverter: {e}")
            await self.disconnect()
            raise ConnectionError(e)

        if response.get("result_code") != 1 or response.get("result_msg") != "success":
            raise InvalidResponseError(f"Invalid websocket response: {response}")

        result_data = typesafe_get(response, "result_data", dict[str, object])
        return typesafe_get(result_data, return_key, return_type)

    async def _get_new_token(self) -> str:
        assert self._token is None

        return await self._ws_query(
            {"lang": "en_us", "token": "", "service": "connect"}, "token", str
        )

    def _debug(self, msg: str):
        logger.debug(f"{self._host}:{self._port} {msg}")

    async def _get_connected_devices(
        self,
    ):
        assert self._token is not None

        return await self._ws_query(
            {
                "lang": "en_us",
                "token": self._token,
                "service": "devicelist",
                "type": "0",
                "is_check_token": "0",
            },
            "list",
            list[dict[str, str]],
        )

    async def connect(self):
        """
        Establish permanent websocket connection to the WiNet dongle
        and retrieve a token.

        Raises ConnectionError if the connection fails.
        """

        if self.connected:
            return

        self._debug("Connecting...")

        ws_endpoint = f"ws://{self._host}:{self._port}/ws/home/overview"
        try:
            self._ws = await self._aio_client.ws_connect(ws_endpoint)

            self._token = await self._get_new_token()

            # The first device is always the inverter.
            # TODO: can we do anything with the others?
            devices = await self._get_connected_devices()
            self._debug(f"Connected devices: {devices}")
            if not devices:
                raise InvalidResponseError(
                    "No devices connected to inverter. This is unexpected."
                )

            self._inverter = devices[0]
            self._debug("Connection via websocket established")
        except ConnectionError:
            await self.disconnect()
            raise
        except TimeoutError as e:
            await self.disconnect()
            raise ConnectionError("Timeout while connecting to inverter") from e
        except Exception as e:
            await self.disconnect()
            raise ConnectionError() from e

    async def disconnect(self):
        self._debug("Disconnecting...")

        self._token = None
        self._inverter = None

        if self._ws:
            await self._ws.close()
            self._ws = None

        # Force completely new connections on next connect()
        await self._aio_client.close()

    @property
    def connected(self) -> bool:
        return self._token is not None

    async def _query_GET(self, url: str, params: dict[str, str | int]):
        """Query the inverter via http GET."""

        try:
            async with await self._aio_client.get(url, params=params) as r:
                if r.status == 200:
                    return cast(dict[str, object], await r.json())
                else:
                    logger.error(
                        "Invalid response from inverter: %s %s", r.status, r.text
                    )
                    raise InvalidResponseError()
        except Exception as e:
            # e.g. response is not valid json
            self._debug(f"Cannot query inverter: {e}")
            raise

    def _build_http_request_for_register_query(
        self, rr: RegisterRange
    ) -> tuple[str, dict[str, str | int]]:
        assert self._inverter
        assert self._token

        param_type = {
            RegisterType.READ: 0,
            RegisterType.HOLD: 1,
        }[rr.register_type]

        # Usually port 80, but we cannot use a hardcoded port in tests.
        # In tests we'll simply reuse the port of the websocket server.
        if "PYTEST_CURRENT_TEST" in os.environ:
            logger.warning("Running in test mode, using websocket port for http")
            port = self._port
        else:
            port = 80

        url = f"http://{self._host}:{port}/device/getParam"
        params: dict[str, str | int] = {
            "dev_id": self._inverter["dev_id"],
            "dev_type": self._inverter["dev_type"],
            "dev_code": self._inverter["dev_code"],
            "type": "3",  # TODO: Why 3?
            "param_addr": rr.start,
            "param_num": rr.length,
            "param_type": param_type,
            "token": self._token,
            "lang": "en_us",
            "time123456": int(time.time()),
        }
        return url, params

    async def _query_http_json(
        self, rr: RegisterRange, retries: int = 3
    ) -> dict[object, object]:
        for attempt in range(retries):
            if attempt > 0:
                # Add 1 second delay before next attempt
                await asyncio.sleep(1)

            try:
                await self.connect()

                # (Re-)build query with current token
                url, params = self._build_http_request_for_register_query(rr)

                response = await self._query_GET(url, params)

                code = _parse_inverter_result_code(response)
                if code == InverterResultCode.SUCCESS:
                    data = response["result_data"]
                    if not isinstance(data, dict):
                        logger.error(
                            f"Invalid response from inverter: {response}, "
                            f"result_data is not a dictionary"
                        )
                        raise InvalidResponseError("Invalid response from inverter")
                    return cast(dict[object, object], data)
                elif code == InverterResultCode.TOKEN_EXPIRED:
                    logger.debug("Token expired, reconnecting")
                    await self.disconnect()
                elif code == InverterResultCode.BUSY:
                    logger.debug("Inverter busy, will retry after some delay")
                    await asyncio.sleep(5)
                else:
                    logger.error(
                        f"Invalid response from inverter: {response}, "
                        f"result_code: {code}"
                    )
                    raise InvalidResponseError("Invalid response from inverter")
            except GenericError as e:
                logger.debug(f"Cannot connect to inverter: {e}")

        # Append last_error / all errors to exception?!
        raise ConnectionError("Repeatedly failed to query inverter")

    async def read_range(self, register_range: RegisterRange) -> list[int]:
        # Note: websocket does not allow access to all possible registers.
        # Not quite clear whether it's worth the effort to query some via websocket and
        # only the rest via http. Potentially better error messages??

        json = await self._query_http_json(register_range)
        json = cast(dict[str, str], json)
        return _parse_modbus_data(json, register_range.length)

    def __str__(self):
        return f"http({self._host}:{self._port})"


class InverterResultCode(Enum):
    SUCCESS = 1
    TOKEN_EXPIRED = 106
    BUSY = 301


def _parse_inverter_result_code(response: dict[str, object]):
    logger.debug(f"Response: {response}")

    try:
        return InverterResultCode(response["result_code"])
    except KeyError:
        raise InvalidResponseError(
            f"Invalid response from inverter (no result_code: {response})"
        )
    except ValueError:
        raise InvalidResponseError(
            f"Invalid response from inverter (invalid result_code: {response})"
        )


def _parse_modbus_data(response_json: dict[str, str], expected_length: int):
    modbus_data = response_json["param_value"].split(" ")
    logger.debug(f"Got modbus data: {modbus_data}")

    # There is always an extra null at the end, remove it.
    modbus_data.pop()

    if len(modbus_data) != expected_length * 2:
        logger.error(
            "Invalid response from inverter: "
            f"{response_json} => {modbus_data}, "
            f"expected length {expected_length}"
        )
        raise InvalidResponseError("Incorrect length of modbus data")

    # Merge two consecutive bytes into 16 bit integers, same as pymodbus.
    # Maybe it would be better to use bytes everywhere...
    # but pymodbus was implemented first.
    data: list[int] = []
    for i in range(0, len(modbus_data), 2):
        data.append(int(modbus_data[i], 16) * 256 + int(modbus_data[i + 1], 16))  # noqa: PERF401
    return data
