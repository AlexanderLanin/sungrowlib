import sungrowlib


async def test_hello():
    client = await sungrowlib.AsyncModbusClient.create(
        sungrowlib.ConnectionParams("localhost", 502, sungrowlib.ConnectionMode.MODBUS),
        None,
    )
    assert client is not None
    assert client.connected is True
