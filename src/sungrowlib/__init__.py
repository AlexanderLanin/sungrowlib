from .AsyncModbusClient import SungrowClient as SungrowClient
from .transports import AsyncModbusTransport as AsyncModbusTransport
from .transports import ConnectionMode as ConnectionMode
from .transports import (
    ConnectionParams as ConnectionParams,
)
from .types import ConnectionError as ConnectionError

# TODO: how do make DEVELOPMENT = True only in dev mode?
DEVELOPMENT = True
if DEVELOPMENT:
    from beartype.claw import beartype_this_package  # <-- boilerplate for victory

    beartype_this_package()  # <-- yay! your team just won
