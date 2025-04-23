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
from typing import Any, cast

import aiohttp
from result import Err, Ok, Result

from sungrowlib.AsyncModbusClient import BusyError, ConnectionError, ModbusError
from sungrowlib.types import RegisterRange, RegisterType
from sungrowlib.util import get_key

logger = logging.getLogger(__name__)


class TokenExpiredError(Err):
    """Token expired, fetch a new token first."""

    def __init__(self):
        super().__init__("Token expired, fetch a new token first")


class HttpTransport:
    def __init__(self, host: str, port: int | None = None):
        if not port:
            port = self.default_port()
        self._host = host
        self._port = port

        # TODO: document why we keep an aiohttp.ClientSession around
        self._aio_client = aiohttp.ClientSession()
        self._ws: aiohttp.client.ClientWebSocketResponse | None = None

        self._token: str | None = None
        self._inverter: dict[str, str] | None = None

    @staticmethod
    def default_port() -> int:
        return 8082

    async def _ws_query(self, query: dict[str, str | int]):
        # Potential services: connect, devicelist, state, statistics, runtime, real
        if self._ws is None:
            raise RuntimeError("Websocket not connected")

        try:
            await self._ws.send_json(query)
            response: dict = await self._ws.receive_json()
        except Exception as e:
            logger.error(f"Cannot send message to inverter: {e}")
            await self.disconnect()
            return ConnectionError()

        if (
            isinstance(response, dict)
            and response.get("result_code") == 1
            and response.get("result_msg") == "success"
            and response.get("result_data")  # is not None
        ):
            return Ok(response["result_data"])
        else:
            logger.error(f"Invalid websocket response from inverter: {response}")
            return ConnectionError()

    async def _get_new_token(self) -> Result[str, ConnectionError]:
        response = await self._ws_query(
            {"lang": "en_us", "token": "", "service": "connect"}
        )
        return get_key(response, "token", str) or ConnectionError()

    def _debug(self, msg: str):
        logger.debug(f"{self._host}:{self._port} {msg}")

    async def _get_connected_devices(
        self,
    ) -> Result[list, ConnectionError]:
        assert self._token is not None

        response = await self._ws_query(
            {
                "lang": "en_us",
                "token": self._token,
                "service": "devicelist",
                "type": "0",
                "is_check_token": "0",
            }
        )
        return get_key(response, "list", list) or ConnectionError()

    async def connect(self):
        """
        Establish permanent websocket connection to the WiNet dongle
        and retrieve a token.

        Returns true/false on success/failure.
        """

        if self.connected:
            return True

        self._debug("Connecting...")

        ws_endpoint = f"ws://{self._host}:{self._port}/ws/home/overview"
        try:
            self._ws = await self._aio_client.ws_connect(ws_endpoint)

            self._token = (await self._get_new_token()).expect("Failed to get token")

            # The first device is always the inverter.
            # TODO: can we do anything with the others?
            devices = (await self._get_connected_devices()).expect(
                "Failed to get devices"
            )
            self._debug(f"Connected devices: {devices}")
            if not devices:
                self._debug("Inverter reports no devices are connected")
                return False
            else:
                self._inverter = devices[0]
                self._debug("Connection via websocket established")
                return True
        except Exception:
            await self.disconnect()
            return False

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

    async def _query_GET(
        self, url: str, params: dict[str, str | int]
    ) -> dict[str, Any] | ConnectionError:
        """Query the inverter via http GET."""

        try:
            async with await self._aio_client.get(url, params=params) as r:
                if r.status == 200:
                    return cast(dict, await r.json())
                else:
                    logger.error(
                        "Invalid response from inverter: %s %s", r.status, r.text
                    )
                    return ConnectionError()
        except Exception as e:
            # e.g. response is not valid json
            self._debug(f"Cannot query inverter: {e}")
            return ConnectionError()

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
        self, rr: RegisterRange
    ) -> Result[dict, ConnectionError]:
        for attempt in range(3):
            if attempt > 0:
                # Add 1 second delay before next attempt
                await asyncio.sleep(1)

            if not await self.connect():
                continue

            # (Re-)build query with current token
            url, params = self._build_http_request_for_register_query(rr)

            response = await self._query_GET(url, params)
            if isinstance(response, ConnectionError):
                continue

            parsed = _parse_sungrow_response(response)
            if isinstance(parsed, Err):
                if isinstance(parsed.err_value, TokenExpiredError):
                    logger.debug("Token expired, reconnecting")
                    await self.disconnect()
                elif isinstance(parsed.err_value, BusyError):
                    logger.debug("Inverter busy, will retry after some delay")
                    await asyncio.sleep(5)
                # in any case, we will retry
                continue
            return parsed

        # TODO: append last_error to error message?!
        return ConnectionError()

    async def read_range(self, rr: RegisterRange) -> Result[list[int], ModbusError]:
        # Note: websocket does not allow access to all possible registers.
        # Not quite clear whether it's worth the effort to query some via websocket and
        # only the rest via http. Potentially better error messages??

        json = await self._query_http_json(rr)
        if isinstance(json, Ok):
            return _parse_modbus_data(json.ok_value, rr.length)
        else:
            return json

    def __str__(self):
        return f"http({self._host}:{self._port})"


def _parse_sungrow_response(
    response: dict[str, Any],
) -> Result[dict, ConnectionError | TokenExpiredError | BusyError]:
    logger.debug(f"Response: {response}")
    if response["result_code"] == 1:
        return Ok(response["result_data"])
    elif response["result_code"] == 106:
        return TokenExpiredError()
    elif response["result_code"] == 301:
        # Wild guess what 301 means. It's not in the official documentation.
        # Seems to work out if we retry after a reasonable delay.
        return BusyError()
    else:
        logger.error(
            f"Invalid response from inverter: {response}, "
            f"result_code: {response['result_code']}"
        )
        return ConnectionError()


def _parse_modbus_data(
    response_json: dict[str, str], expected_length: int
) -> Result[list[int], ConnectionError]:
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
        return ConnectionError()

    data: list[int] = []
    # Merge two consecutive bytes into 16 bit integers, same as pymodbus.
    # Maybe it would be better to use bytes everywhere...
    # but pymodbus was implemented first.
    for i in range(0, len(modbus_data), 2):
        data.append(int(modbus_data[i], 16) * 256 + int(modbus_data[i + 1], 16))  # noqa: PERF401
    return Ok(data)
