import simulation

import sungrowlib


async def test_modbus_connect():
    async with simulation.simulate_modbus_inverter(None) as port:
        client = await sungrowlib.AsyncModbusClient.create(
            sungrowlib.ConnectionParams(
                "localhost", port, sungrowlib.ConnectionMode.MODBUS
            ),
            None,
        )
        assert client is not None
        assert client.connected is True

        await client.disconnect()


async def test_modbus_connect_with_undefined_mode():
    async with simulation.simulate_modbus_inverter(None) as port:
        client = await sungrowlib.AsyncModbusClient.create(
            sungrowlib.ConnectionParams("localhost", port, None),
            None,
        )
        assert client is not None
        assert client.connected is True

        await client.disconnect()
