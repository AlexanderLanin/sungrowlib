# sungrowlib
:warning: Just getting started... nothing is working yet :warning:


`sungrowlib` is a high level abstraction layer for accessing Sungrow inverters from python.

This project is on no way associated with Sungrow.

## Why another library?
Existing libraries lack some features that I consider important:

* support modbus and http connections including automatic detection
* detect which signals are supported
* query only what is necessary
* provide complex signals, such as date construction based on other signals
* provide a simple and type-safe async API
* proper error handling
* include a default list of signals


## Comparable projects

* [SungrowClient](https://github.com/bohdan-s/SungrowClient) supports modbus, http and encrypted-modbus connection.
* TODO
