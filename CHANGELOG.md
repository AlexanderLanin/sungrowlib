# Changelog

## 0.1.0

Initial release.

- Modbus TCP transport via `modbus-serial`
- HTTP/WebSocket transport for WiNet-S dongles (mock-tested)
- 288-register catalog for SH/SG series inverters
- Model-based register filtering with fnmatch globs
- Group-based feature detection (has_meter, has_battery, etc.)
- 5-level register detail system
- Master/slave topology auto-detection
- `SungrowInverter` and `SungrowSystem` high-level API
- Computed registers: timestamp synthesis, MPPT power (P=V*I)
- Signal support state machine (5-state 0-ambiguity resolver)
- Typed error hierarchy with Modbus and HTTP error types
- Retry logic with reconnect for ConnectionError
- Throttling (configurable min interval between calls)
- Problematic register tracking (failed addresses as block boundaries)
- Connection statistics
- S16 0x7FFF as N/A sentinel
