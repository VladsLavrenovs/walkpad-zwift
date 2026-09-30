"""Command-line interface: `walkpad-bridge scan|inspect|live|speed|stop`."""

from __future__ import annotations

import asyncio
import contextlib
import enum
import logging
import signal
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Annotated

import typer

from . import ble
from .backend import BackendError, BeltState, PadBackend, Sample
from .blebackend import BleBackend
from .clock import Clock, MonotonicClock, ScaledClock
from .config import Config, load_config
from .fake import FakeBackend
from .safety import SpeedController

CLIENT = "cli"
STOP_CONFIRM_TIMEOUT_S = 30.0

app = typer.Typer(no_args_is_help=True, help="WalkPad bridge.")

FakeOpt = Annotated[bool, typer.Option("--fake", help="Use the simulated pad.")]
ControlFakeOpt = Annotated[
    bool,
    typer.Option(
        "--fake", help="Use the simulated pad (required: real-device control is not implemented yet)."
    ),
]
AddressArg = Annotated[
    str | None,
    typer.Argument(help="Pad BLE address (see `scan`). Default: [ble] address in config.toml."),
]
FakeSpeedOpt = Annotated[
    float, typer.Option(help="FAKE only: speed the simulated pad is already walking at (0 = stopped).")
]
TimeScaleOpt = Annotated[float, typer.Option(hidden=True, help="FAKE only: run time faster.")]
ConfigOpt = Annotated[Path | None, typer.Option(help="Config file (default: bridge/config.toml).")]


class ProtocolChoice(enum.StrEnum):
    AUTO = "auto"
    KINGSMITH = "kingsmith"
    FTMS = "ftms"


ProtocolOpt = Annotated[
    ProtocolChoice | None,
    typer.Option(help="Pad protocol. Default: [ble] protocol in config.toml (auto)."),
]


@app.callback()
def main(
    verbose: Annotated[bool, typer.Option("--verbose", "-v")] = False,
    debug: Annotated[
        bool, typer.Option("--debug", help="Also log raw BLE frames (bridge logs only).")
    ] = False,
) -> None:
    logging.basicConfig(
        level=logging.INFO if verbose or debug else logging.WARNING,
        format="%(levelname)s %(message)s",
    )
    if debug:
        logging.getLogger("walkpad_bridge").setLevel(logging.DEBUG)


def format_sample(s: Sample) -> str:
    minutes, seconds = divmod(int(s.elapsed_s), 60)
    steps = "--" if s.steps is None else str(s.steps)
    return (
        f"{s.speed_kmh:4.1f} km/h | {s.distance_m:8.1f} m | {steps:>6} steps | "
        f"{minutes:02d}:{seconds:02d} | {s.belt}"
    )


def _make_fake(fake_speed: float, time_scale: float) -> tuple[FakeBackend, Clock]:
    clock: Clock = MonotonicClock() if time_scale == 1 else ScaledClock(time_scale)
    return FakeBackend(initial_speed_kmh=fake_speed, clock=clock), clock


def _make_control_backend(
    fake: bool, fake_speed: float, time_scale: float
) -> tuple[PadBackend, Clock]:
    if not fake:
        typer.echo(
            "Belt control on the real pad is not implemented yet; use --fake. "
            "`live ADDRESS` reads live data from the real pad.",
            err=True,
        )
        raise typer.Exit(2)
    return _make_fake(fake_speed, time_scale)


def _resolve_address(address: str | None, cfg: Config) -> str:
    address = address or cfg.ble.address
    if not address:
        typer.echo(
            "Give the pad's ADDRESS (find it with `walkpad-bridge scan`), set [ble] address "
            "in config.toml, or use --fake.",
            err=True,
        )
        raise typer.Exit(2)
    return address


def _resolve_protocol(choice: ProtocolChoice | None, cfg: Config) -> ble.Protocol | None:
    if choice is None:
        return cfg.ble.protocol_or_none
    return None if choice is ProtocolChoice.AUTO else ble.Protocol(choice.value)


def _hint(text: str) -> None:
    typer.echo(typer.style(text, dim=True), err=True)


REMINDER = "Reminder: close the KS Fit phone app, and do not pair the pad in bluetoothctl."


async def _print_samples(
    backend: PadBackend,
    count: int | None = None,
    on_sample: Callable[[Sample], None] | None = None,
) -> None:
    async with contextlib.aclosing(backend.samples()) as samples:
        n = 0
        async for sample in samples:
            if on_sample is not None:
                on_sample(sample)
            typer.echo(format_sample(sample))
            n += 1
            if count is not None and n >= count:
                return


async def _print_until_stopped(backend: PadBackend) -> None:
    """Print samples until the pad reports the belt stopped (real-time timeout)."""
    if not backend.is_connected or backend.belt_state is BeltState.STOPPED:
        return
    try:
        async with asyncio.timeout(STOP_CONFIRM_TIMEOUT_S):
            async with contextlib.aclosing(backend.samples()) as samples:
                async for sample in samples:
                    typer.echo(format_sample(sample))
                    if sample.belt is BeltState.STOPPED:
                        return
    except TimeoutError:
        typer.echo("WARNING: pad did not report the belt stopped. Check it!", err=True)


def _shutdown_signals() -> list[signal.Signals]:
    # Windows has no SIGHUP and its SIGTERM cannot be caught; Ctrl+Break is SIGBREAK there.
    names = ("SIGINT", "SIGBREAK") if sys.platform == "win32" else ("SIGINT", "SIGTERM", "SIGHUP")
    return [getattr(signal, name) for name in names if hasattr(signal, name)]


@contextlib.contextmanager
def _signal_handlers(on_signal: Callable[[signal.Signals], None]) -> Iterator[None]:
    """Route shutdown signals to `on_signal` inside the event loop; restore handlers after."""
    loop = asyncio.get_running_loop()
    sigs = _shutdown_signals()
    previous = {}
    for sig in sigs:
        if sys.platform == "win32":
            previous[sig] = signal.signal(
                sig,
                lambda signum, _frame: loop.call_soon_threadsafe(
                    on_signal, signal.Signals(signum)
                ),
            )
        else:
            loop.add_signal_handler(sig, on_signal, sig)
    try:
        yield
    finally:
        for sig in sigs:
            if sys.platform == "win32":
                signal.signal(sig, previous[sig])
            else:
                loop.remove_signal_handler(sig)


@app.command()
def scan(
    timeout: Annotated[
        float | None, typer.Option(help="Seconds to scan. Default: [ble] scan_timeout_s.")
    ] = None,
    config: ConfigOpt = None,
) -> None:
    """List nearby BLE devices. Likely WalkingPads are marked with * and listed first."""
    cfg = load_config(config)
    seconds = timeout if timeout is not None else cfg.ble.scan_timeout_s
    _hint(REMINDER)
    typer.echo(f"Scanning for {seconds:g} s...")
    try:
        results = asyncio.run(ble.scan(seconds))
    except BackendError as exc:
        typer.echo(f"Error: {exc}. Is Bluetooth on? (`bluetoothctl show`)", err=True)
        raise typer.Exit(1) from exc
    if not results:
        typer.echo("No BLE devices found.")
        return
    for r in results:
        rssi = "   ?" if r.rssi is None else f"{r.rssi:4d}"
        line = f"{'*' if r.likely_pad else ' '} {r.address}  {rssi} dBm  {r.name or '(no name)'}"
        if r.likely_pad:
            line = typer.style(f"{line}  [{', '.join(r.reasons)}]", fg="green", bold=True)
        typer.echo(line)
    pads = [r for r in results if r.likely_pad]
    if pads:
        typer.echo(f"\nNext: walkpad-bridge inspect {pads[0].address}")
    else:
        typer.echo("\nNo likely WalkingPad found. Is it powered on and not connected to the phone?")


@app.command()
def inspect(address: AddressArg = None, config: ConfigOpt = None) -> None:
    """Connect, dump all GATT services and characteristics, and report the pad protocol.

    Only reads; never writes to the device.
    """
    cfg = load_config(config)
    address = _resolve_address(address, cfg)
    _hint(REMINDER)

    async def run() -> ble.InspectReport:
        client = await ble.connect_client(address, cfg.ble.connect_timeout_s, lambda: None)
        try:
            return await ble.inspect(client)
        finally:
            with contextlib.suppress(Exception):
                await client.disconnect()

    typer.echo(f"Connecting to {address}...")
    try:
        report = asyncio.run(run())
    except BackendError as exc:
        typer.echo(f"Error: {exc}", err=True)
        raise typer.Exit(1) from exc

    for service in report.services:
        typer.echo(typer.style(f"[service] {service.uuid}  {service.description}", bold=True))
        for c in service.characteristics:
            typer.echo(f"  [char] {c.uuid}  handle={c.handle}  ({', '.join(c.properties)})  {c.description}")
            if c.value is not None:
                typer.echo(f"      value: {ble.format_value(c.value)}")
            elif c.error is not None:
                typer.echo(f"      read failed: {c.error}")
            for d in c.descriptors:
                typer.echo(f"      [descriptor] {d}")
    typer.echo("")
    if report.protocols:
        names = {ble.Protocol.FTMS: "FTMS (0x1826)", ble.Protocol.KINGSMITH: "KingSmith proprietary (0xFE00)"}
        typer.echo("Protocols: " + ", ".join(names[p] for p in report.protocols))
        typer.echo(f"Auto-select would use: {report.protocols[0]}")
    else:
        typer.echo("Protocols: none recognised (neither FTMS 0x1826 nor KingSmith 0xFE00).")
    if report.ftms_speed_range is not None:
        r = report.ftms_speed_range
        typer.echo(f"FTMS speed range: {r.min_kmh:g}-{r.max_kmh:g} km/h, step {r.resolution_kmh:g}")
    for note in report.notes:
        typer.echo(f"Note: {note}")
    if not report.protocols:
        raise typer.Exit(1)


@app.command()
def live(
    address: AddressArg = None,
    fake: FakeOpt = False,
    protocol: ProtocolOpt = None,
    count: Annotated[int | None, typer.Option(help="Stop after N samples.")] = None,
    fake_speed: FakeSpeedOpt = 3.0,
    config: ConfigOpt = None,
    time_scale: TimeScaleOpt = 1.0,
) -> None:
    """Print live samples. Read-only: never controls the belt."""
    cfg = load_config(config)
    backend: PadBackend
    if fake:
        backend, _ = _make_fake(fake_speed, time_scale)
    else:
        address = _resolve_address(address, cfg)
        _hint(REMINDER)
        typer.echo(f"Connecting to {address}...")
        backend = BleBackend(
            address,
            protocol=_resolve_protocol(protocol, cfg),
            connect_timeout_s=cfg.ble.connect_timeout_s,
            kingsmith_poll_s=cfg.ble.kingsmith_poll_s,
            connector=ble.connect_client,
        )

    async def run() -> bool:
        """True if the sample stream ended because the connection dropped."""
        await backend.connect()
        if isinstance(backend, BleBackend):
            typer.echo(f"Connected ({backend.protocol}). Read-only. Ctrl+C to quit.")
        try:
            await _print_samples(backend, count)
            return count is None or not backend.is_connected
        finally:
            await backend.disconnect()

    try:
        lost = asyncio.run(run())
    except BackendError as exc:
        typer.echo(f"Error: {exc}", err=True)
        raise typer.Exit(1) from exc
    except KeyboardInterrupt:
        return
    if lost:
        typer.echo("Connection to the pad lost.", err=True)
        raise typer.Exit(1)


@app.command()
def speed(
    kmh: Annotated[float, typer.Argument(help="Target speed in km/h (clamped to the safety cap).")],
    fake: ControlFakeOpt = False,
    hold: Annotated[
        float | None,
        typer.Option(help="Seconds to keep walking after reaching the target (default: until Ctrl+C)."),
    ] = None,
    fake_speed: FakeSpeedOpt = 0.0,
    config: ConfigOpt = None,
    time_scale: TimeScaleOpt = 1.0,
) -> None:
    """Start the belt if needed and ramp to KMH. The belt stops when this command exits.

    SIGINT (Ctrl+C), SIGTERM and SIGHUP (Ctrl+C / Ctrl+Break on Windows) stop the belt,
    wait until the pad reports it stopped, and exit 0.
    """
    cfg = load_config(config)
    backend, clock = _make_control_backend(fake, fake_speed, time_scale)

    async def walk(controller: SpeedController) -> None:
        if backend.belt_state is not BeltState.RUNNING:
            await controller.start(client=CLIENT)
        target = await controller.set_speed(kmh, client=CLIENT)
        if target != kmh:
            typer.echo(f"Requested {kmh} km/h, clamped to {target} km/h by safety limits.")
        await controller.wait_until_reached()
        typer.echo(f"Reached {target} km/h.")
        if hold is None:
            typer.echo("Walking. Press Ctrl+C to stop the belt.")
            await asyncio.Event().wait()
        else:
            await clock.sleep(hold)

    async def run() -> None:
        shutdown = asyncio.Event()

        def on_signal(sig: signal.Signals) -> None:
            if not shutdown.is_set():
                typer.echo(f"Received {sig.name}; stopping the belt.")
            shutdown.set()

        with _signal_handlers(on_signal):
            await backend.connect()
            controller = SpeedController(backend, cfg.safety, clock)
            printer = asyncio.create_task(_print_samples(backend, on_sample=controller.observe))
            try:
                walking = asyncio.create_task(walk(controller))
                signalled = asyncio.create_task(shutdown.wait())
                try:
                    await asyncio.wait({walking, signalled}, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    signalled.cancel()
                    walking.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await walking  # re-raises a real error from walk()
            finally:
                # Controlling client going away must stop the belt. Signal handlers stay
                # installed meanwhile, so a second Ctrl+C cannot interrupt the stop.
                printer.cancel()
                await controller.client_disconnected(CLIENT)
                await _print_until_stopped(backend)
                await controller.close()
                typer.echo("Belt stopped.")

    asyncio.run(run())


@app.command()
def stop(
    fake: ControlFakeOpt = False,
    fake_speed: FakeSpeedOpt = 3.0,
    config: ConfigOpt = None,
    time_scale: TimeScaleOpt = 1.0,
) -> None:
    """Stop the belt and wait until it has stopped."""
    cfg = load_config(config)
    backend, clock = _make_control_backend(fake, fake_speed, time_scale)

    async def run() -> None:
        await backend.connect()
        controller = SpeedController(backend, cfg.safety, clock)
        try:
            await controller.stop(client=CLIENT)
            await _print_until_stopped(backend)
            typer.echo("Belt stopped.")
        finally:
            await controller.close()

    asyncio.run(run())
