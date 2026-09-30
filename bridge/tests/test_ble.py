import pytest

from fakegatt import FakeChar, FakeGattClient, FakeService, ftms_services, ks_services
from walkpad_bridge import ble
from walkpad_bridge.backend import BackendError
from walkpad_bridge.ble import Protocol


@pytest.mark.parametrize(
    ("name", "uuids", "expected"),
    [
        ("WalkingPad", [], ("name",)),
        ("KS-ST-A1P", [], ("name",)),
        ("ks_hd_z1d", [], ("name",)),
        ("KingSmith R2", [ble.FTMS_SERVICE], ("name", "FTMS 1826")),
        (None, [ble.KS_SERVICE.upper()], ("KingSmith service FE00",)),
        ("Galaxy Buds", [ble.uuid16("180f")], ()),
        ("Socks", [], ()),  # "ks" only counts as a prefix
        (None, [], ()),
    ],
)
def test_classify(name: str | None, uuids: list[str], expected: tuple[str, ...]) -> None:
    assert ble.classify(name, uuids) == expected


def test_detect_prefers_ftms() -> None:
    both = [ble.KS_SERVICE, ble.uuid16("180a"), ble.FTMS_SERVICE]
    assert ble.detect_protocols(both) == [Protocol.FTMS, Protocol.KINGSMITH]
    assert ble.choose_protocol(both) is Protocol.FTMS
    assert ble.choose_protocol(both, Protocol.KINGSMITH) is Protocol.KINGSMITH
    assert ble.choose_protocol([ble.KS_SERVICE]) is Protocol.KINGSMITH


def test_choose_protocol_errors() -> None:
    with pytest.raises(BackendError, match="neither"):
        ble.choose_protocol([ble.uuid16("180a")])
    with pytest.raises(BackendError, match="does not offer the ftms"):
        ble.choose_protocol([ble.KS_SERVICE], Protocol.FTMS)


async def test_inspect_kingsmith_reads_but_never_writes() -> None:
    client = FakeGattClient(ks_services(), lambda: None)
    client.services[0].characteristics.append(
        FakeChar(ble.uuid16("2a26"), 5, ["read"], "Firmware", read_error=RuntimeError("denied"))
    )
    report = await ble.inspect(client)
    assert report.protocols == (Protocol.KINGSMITH,)
    assert report.notes == ()
    info = report.services[0]
    assert info.description == "Device Information"
    assert info.characteristics[0].value == b"KS-ST-A1P"
    assert info.characteristics[1].error == "denied"
    notify = report.services[1].characteristics[0]
    assert notify.descriptors == (ble.uuid16("2902"),)
    assert client.writes == []


async def test_inspect_ftms_decodes_speed_range() -> None:
    report = await ble.inspect(FakeGattClient(ftms_services(), lambda: None))
    assert report.protocols == (Protocol.FTMS,)
    assert report.ftms_speed_range is not None
    assert report.ftms_speed_range.max_kmh == 6.0


async def test_inspect_notes_unexpected_kingsmith_layout() -> None:
    services = [FakeService(ble.KS_SERVICE, [FakeChar(ble.KS_NOTIFY_CHAR, 1, ["notify"])])]
    report = await ble.inspect(FakeGattClient(services, lambda: None))
    assert "protocol may differ" in report.notes[0]


def test_format_value() -> None:
    assert ble.format_value(b"A1") == '41 31  "A1"'
    assert ble.format_value(b"\x00\xff") == "00 ff"
    assert ble.format_value(b"\x00") == "00"
    # Real WalkingPad model string (NUL-terminated).
    assert ble.format_value(b"WLT8266M\x00") == '57 4c 54 38 32 36 36 4d 00  "WLT8266M"'
