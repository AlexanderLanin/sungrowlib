# Architecture

:warning: Outdated :warning:

```mermaid
---
  config:
    class:
      hideEmptyMembersBox: true
---

classDiagram
    namespace Public-API {
        class ConnectionFactory {
            +create_connection(host, port, connection_str) -> Connection
        }

        class Connection {
            Abstraction Layer
            Determines if signals are supported
        }
        class Signal
    }

    ConnectionFactory ..> Connection : creates

    namespace internal {
        class ModbusSignal
        class ModbusConnection_Base {
            translates between signals and registers
            cleverly combines registers into query ranges
            encodes and decodes data

            +__init__(host, port)
            +connect()
            +disconnect()
            +read(list[Signal]) -> dict(Signal, data)
        }
        class ModbusConnection_Pymodbus
        class ModbusConnection_Http
        class WebsocketConnection {
            Theoretical implementation of the websocket interface
        }
    }

    namespace dependencies {
        class pymodbus~external~
        class aiohttp~external~
    }

    Signal --|> ModbusSignal : !!!
    Connection --> Signal

    Connection <|-- ModbusConnection_Base
    Connection <|-- FakeConnection~testing~

    Connection <|-- WebsocketConnection
    WebsocketConnection ..> aiohttp

    ModbusConnection_Base <|-- ModbusConnection_Pymodbus
    ModbusConnection_Base <|-- ModbusConnection_Http

    ModbusConnection_Base --> ModbusSignal

    ModbusConnection_Http ..> aiohttp

    ModbusConnection_Pymodbus ..> pymodbus
```

### State machine for signal supported flag

Note: Sungrow inverters return 0 for unsupported signals when they are queried together with other signals. Therefore any 0 response is ambiguous and requires a follow-up query with only the signal in question.

```mermaid
stateDiagram
    [*] --> NEVER_ATTEMPTED

    NEVER_ATTEMPTED --> UNKNOWN: 0 && multi-signal query
    NEVER_ATTEMPTED --> CONFIRMED_UNKNOWN: 0 && single-signal query
    NEVER_ATTEMPTED --> YES: !0
    NEVER_ATTEMPTED --> NO: unsupported error

    UNKNOWN --> CONFIRMED_UNKNOWN: 0
    UNKNOWN --> YES: !0
    UNKNOWN --> NO: unsupported error
```
