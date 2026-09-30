"""Command-line interface: `walkpad-bridge scan|inspect|live|speed|stop|serve`."""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import enum
import logging
import signal
import sys
import time
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
from .lag import LagMeter
from .safety import SafetyConfig, SafetyError, SpeedController
from .service import wait_until_moving

CLIENT = "cli"
STOP_CONFIRM_TIMEOUT_S = 30.0
STOP_RETRY_S = 3.0  # resend stop if the pad still reports the belt running this long after
OWED_STOP_RETRY_S = 60.0  # link lost and recovery gave up: keep trying to deliver the stop
FIRST_STATUS_TIMEOUT_S = 10.0
DEFAULT_LOG_DIR = Path(__file__).resolve().parents[2] / "logs"

log = logging.getLogger(__name__)
sample_log = logging.getLogger("walkpad_bridge.samples")  # manual-test log file only

app = typer.Typer(no_args_is_help=True, help="WalkPad bridge.")

FakeOpt = Annotated[bool, typer.Option("--fake", help="Use the simulated pad.")]
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


def _make_ble(address: str | None, protocol: ProtocolChoice | None, cfg: Config) -> BleBackend:
    address = _resolve_address(address, cfg)
    _hint(REMINDER)
    typer.echo(f"Connecting to {address}...")
    return BleBackend(
        address,
        protocol=_resolve_protocol(protocol, cfg),
        connect_timeout_s=cfg.ble.connect_timeout_s,
        kingsmith_poll_s=cfg.ble.kingsmith_poll_s,
        connector=ble.connect_client,
    )


def _safety_config(cfg: Config, max_speed: float | None) -> SafetyConfig:
    """`--max-speed` can only lower the configured cap; raising it means editing config.toml."""
    if max_speed is None:
        return cfg.safety
    if not (0 < max_speed <= cfg.safety.max_speed_kmh):
        typer.echo(
            f"--max-speed must be above 0 and at most the configured cap "
            f"({cfg.safety.max_speed_kmh} km/h in config.toml).",
            err=True,
        )
        raise typer.Exit(2)
    return dataclasses.replace(cfg.safety, max_speed_kmh=max_speed)


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
    muted: asyncio.Event | None = None,
) -> None:
    """Print samples; while `muted` is set they go to the log file only (e.g. during a prompt)."""
    async with contextlib.aclosing(backend.samples()) as samples:
        n = 0
        async for sample in samples:
            if on_sample is not None:
                on_sample(sample)
            if muted is not None and muted.is_set():
                sample_log.debug("%s", format_sample(sample))
            else:
                _echo_sample(sample)
            n += 1
            if count is not None and n >= count:
                return


async def _print_until_stopped(
    backend: PadBackend,
    controller: SpeedController | None = None,
    on_sample: Callable[[Sample], None] | None = None,
) -> bool:
    """Print samples until the pad reports the belt stopped (real-time timeout).

    With a controller, stop is sent again whenever the pad still reports the belt running
    STOP_RETRY_S after the last stop (a dropped BLE write must not leave the belt running).
    Returns True only once the pad reports it stopped.
    """
    if not backend.is_connected:
        typer.echo("WARNING: not connected, cannot confirm the belt stopped. Check the pad!", err=True)
        return False
    if backend.belt_state is BeltState.STOPPED:
        return True
    loop = asyncio.get_running_loop()
    last_stop = loop.time()
    try:
        async with asyncio.timeout(STOP_CONFIRM_TIMEOUT_S):
            async with contextlib.aclosing(backend.samples()) as samples:
                async for sample in samples:
                    if on_sample is not None:
                        on_sample(sample)
                    _echo_sample(sample)
                    if sample.belt is BeltState.STOPPED:
                        return True
                    if (
                        controller is not None
                        and sample.belt is BeltState.RUNNING
                        and loop.time() - last_stop >= STOP_RETRY_S
                    ):
                        typer.echo("Pad still reports the belt running; sending stop again.", err=True)
                        with contextlib.suppress(BackendError):
                            await controller.stop()
                        last_stop = loop.time()
    except TimeoutError:
        pass
    typer.echo("WARNING: pad did not report the belt stopped. Check it!", err=True)
    return False


def _echo_sample(sample: Sample) -> None:
    line = format_sample(sample)
    typer.echo(line)
    sample_log.debug("%s", line)


async def _first_sample(backend: PadBackend) -> Sample | None:
    """The pad's current status (waits for the first report after connecting)."""
    try:
        async with asyncio.timeout(FIRST_STATUS_TIMEOUT_S):
            async with contextlib.aclosing(backend.samples()) as samples:
                async for sample in samples:
                    return sample
    except TimeoutError:
        pass
    return None


async def _wait_until_moving(backend: PadBackend) -> None:
    """After start: wait until the belt actually moves (the pad counts down first)."""
    sample = await wait_until_moving(backend)
    typer.echo(f"Belt moving at {sample.speed_kmh:.1f} km/h.")


async def _until_belt_stops(backend: PadBackend) -> None:
    """Returns when the pad reports the belt stopped or stopping."""
    async with contextlib.aclosing(backend.samples()) as samples:
        async for sample in samples:
            if sample.belt is not BeltState.RUNNING:
                return
    await asyncio.Event().wait()  # connection lost: the connection-lost path handles that


async def _read_line() -> str:
    """Read a line from stdin without blocking the event loop (so Ctrl+C still works)."""
    try:
        fd = sys.stdin.fileno()
    except (AttributeError, OSError, ValueError):
        fd = None
    if fd is None or sys.platform == "win32":
        return sys.stdin.readline()  # test runners and Windows dev: blocking is fine there
    loop = asyncio.get_running_loop()
    future: asyncio.Future[str] = loop.create_future()

    def ready() -> None:
        if not future.done():
            future.set_result(sys.stdin.readline())

    loop.add_reader(fd, ready)
    try:
        return await future
    finally:
        loop.remove_reader(fd)


@contextlib.contextmanager
def _manual_test_logging(log_dir: Path, debug: bool) -> Iterator[Path]:
    """Everything (commands, raw frames, samples, lag) to a file; INFO and up on the console."""
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / f"manual-test-{time.strftime('%Y%m%d-%H%M%S')}.log"
    file_handler = logging.FileHandler(path)
    file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    console = list(logging.getLogger().handlers)
    saved = [(h, h.level) for h in console]

    def not_samples(record: logging.LogRecord) -> bool:
        return record.name != sample_log.name  # samples are echoed already; file only

    for handler in console:
        handler.setLevel(logging.DEBUG if debug else logging.INFO)
        handler.addFilter(not_samples)
    bridge_logger = logging.getLogger("walkpad_bridge")
    old_level = bridge_logger.level
    bridge_logger.setLevel(logging.DEBUG)
    bridge_logger.addHandler(file_handler)
    try:
        yield path
    finally:
        bridge_logger.removeHandler(file_handler)
        bridge_logger.setLevel(old_level)
        file_handler.close()
        for handler, level in saved:
            handler.setLevel(level)
            handler.removeFilter(not_samples)


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
        backend = _make_ble(address, protocol, cfg)

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
    address: AddressArg = None,
    fake: FakeOpt = False,
    manual_test: Annotated[
        bool,
        typer.Option(
            "--manual-test",
            help="Manual hardware test: show the plan, ask before the first command, log to "
            "bridge/logs/. Required for the real pad.",
        ),
    ] = False,
    max_speed: Annotated[
        float | None,
        typer.Option(help="Lower the speed cap for this run (km/h). Cannot exceed config.toml."),
    ] = None,
    hold: Annotated[
        float | None,
        typer.Option(help="Seconds to keep walking after reaching the target (default: until Ctrl+C)."),
    ] = None,
    protocol: ProtocolOpt = None,
    fake_speed: FakeSpeedOpt = 0.0,
    config: ConfigOpt = None,
    log_dir: Annotated[Path, typer.Option(hidden=True)] = DEFAULT_LOG_DIR,
    time_scale: TimeScaleOpt = 1.0,
) -> None:
    """Start the belt if needed and ramp to KMH. The belt stops when this command exits.

    SIGINT (Ctrl+C), SIGTERM and SIGHUP (Ctrl+C / Ctrl+Break on Windows) stop the belt,
    wait until the pad reports it stopped, and exit 0.
    """
    cfg = load_config(config)
    safety = _safety_config(cfg, max_speed)
    if not fake and not manual_test:
        typer.echo(
            "Belt control on the real pad needs --manual-test for now "
            "(see the manual test plan in bridge/README.md).",
            err=True,
        )
        raise typer.Exit(2)
    backend: PadBackend
    if fake:
        backend, clock = _make_fake(fake_speed, time_scale)
    else:
        backend, clock = _make_ble(address, protocol, cfg), MonotonicClock()
    debug = logging.getLogger("walkpad_bridge").level == logging.DEBUG  # global --debug

    with contextlib.ExitStack() as stack:
        if manual_test:
            log_path = stack.enter_context(_manual_test_logging(log_dir, debug))
            typer.echo(f"Logging this test to {log_path}")
        try:
            asyncio.run(_speed_session(backend, clock, safety, kmh, hold, manual_test))
        except (BackendError, SafetyError, ValueError) as exc:
            typer.echo(f"Error: {exc}", err=True)
            raise typer.Exit(1) from exc


async def _confirm_manual_test(
    backend: PadBackend, controller: SpeedController, kmh: float, muted: asyncio.Event
) -> bool:
    status = await _first_sample(backend)
    if status is None:
        raise BackendError("no status from the pad; not sending anything")
    if status.belt is not BeltState.STOPPED:
        raise SafetyError(f"belt is {status.belt}; stop it first, then start the manual test")
    cfg = controller.config
    protocol = getattr(backend, "protocol", "fake")
    typer.echo("")
    typer.echo(typer.style("MANUAL HARDWARE TEST", bold=True))
    typer.echo(f"  pad:      {getattr(backend, 'address', 'simulated')} ({protocol})")
    typer.echo(f"  belt now: {format_sample(status)}")
    typer.echo(
        f"  plan:     start the belt (it starts at the pad's own start speed), then ramp to "
        f"{controller.clamp(kmh):.1f} km/h"
    )
    typer.echo(
        f"  limits:   cap {controller.max_speed_kmh:.1f} km/h, ramp "
        f"{cfg.max_ramp_kmh_per_s:g} km/h per s"
    )
    typer.echo("  stop:     Ctrl+C here, the pad's remote, or the power switch")
    typer.echo("Send the first command? Type 'yes' to go: ", nl=False)
    muted.set()  # keep live samples from printing over the prompt
    try:
        answer = (await _read_line()).strip().lower()
    finally:
        muted.clear()
    return answer == "yes"


async def _speed_session(
    backend: PadBackend,
    clock: Clock,
    safety: SafetyConfig,
    kmh: float,
    hold: float | None,
    manual_test: bool,
) -> None:
    shutdown = asyncio.Event()
    muted = asyncio.Event()
    sent: list[str] = []

    def on_signal(sig: signal.Signals) -> None:
        if not shutdown.is_set():
            typer.echo(f"Received {sig.name}; stopping the belt.")
        shutdown.set()

    def on_connection_lost() -> None:
        typer.echo("Connection to the pad lost; reconnecting to stop the belt.", err=True)
        shutdown.set()

    async def walk(controller: SpeedController) -> None:
        if manual_test and not await _confirm_manual_test(backend, controller, kmh, muted):
            typer.echo("Aborted. Nothing was sent to the pad.")
            return
        if backend.belt_state is not BeltState.RUNNING:
            await controller.start(client=CLIENT)
            await _wait_until_moving(backend)  # the ramp then starts from the actual speed
        target = await controller.set_speed(kmh, client=CLIENT)
        if target != kmh:
            typer.echo(f"Requested {kmh} km/h, clamped to {target} km/h by safety limits.")
        await controller.wait_until_reached()
        typer.echo(f"Reached {target} km/h.")
        if hold is None:
            typer.echo("Walking. Press Ctrl+C to stop the belt.")
        holding = asyncio.create_task(clock.sleep(hold) if hold is not None else asyncio.Event().wait())
        stopped_elsewhere = asyncio.create_task(_until_belt_stops(backend))
        try:
            await asyncio.wait({holding, stopped_elsewhere}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            holding.cancel()
            stopped_elsewhere.cancel()
        if stopped_elsewhere.done() and not stopped_elsewhere.cancelled():
            typer.echo("The pad reports the belt stopped (remote or pad button?). Ending the session.")

    with _signal_handlers(on_signal):
        await backend.connect()
        try:
            controller = SpeedController(backend, safety, clock)
        except ValueError:
            await backend.disconnect()  # e.g. --max-speed below the pad's minimum
            raise
        lag = LagMeter(clock, backend.speed_range.resolution_kmh)
        controller.add_command_listener(lag.on_command)
        controller.add_command_listener(lambda name, _kmh: sent.append(name))
        backend.add_connection_lost_listener(on_connection_lost)

        def on_sample(sample: Sample) -> None:
            controller.observe(sample)
            lag.observe(sample)

        printer = asyncio.create_task(_print_samples(backend, on_sample=on_sample, muted=muted))
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
            try:
                await controller.client_disconnected(CLIENT)
            except BackendError as exc:
                typer.echo(f"ERROR sending stop: {exc}", err=True)
            if controller.recovery_task is not None:
                await controller.recovery_task  # reconnect + stop after a dropped link
            if controller.stop_owed:
                await _deliver_owed_stop(backend, controller, clock)
            stopped = await _print_until_stopped(backend, controller, on_sample)
            await controller.close()
            _report_lag(lag, echo=manual_test)
            if not sent:
                typer.echo("Disconnected.")
            elif stopped:
                typer.echo("Belt stopped.")
            else:
                typer.echo("WARNING: could not confirm the belt stopped. CHECK THE PAD.", err=True)


async def _deliver_owed_stop(
    backend: PadBackend, controller: SpeedController, clock: Clock
) -> bool:
    """The link dropped and recovery gave up: keep trying to reconnect and stop for a while."""
    typer.echo(
        f"Pad unreachable; the belt may still be running. Retrying the stop for "
        f"{OWED_STOP_RETRY_S:g} s. STOP THE PAD MANUALLY if you can.",
        err=True,
    )
    start = clock.now()
    while clock.now() - start < OWED_STOP_RETRY_S:
        try:
            await backend.connect()
            await controller.reconnected()
            typer.echo("Reconnected and sent the stop.", err=True)
            return True
        except BackendError as exc:
            log.warning("owed stop not delivered yet: %s", exc)
            await clock.sleep(2.0)
    typer.echo("GAVE UP: could not reach the pad to stop the belt. STOP IT MANUALLY.", err=True)
    return False


def _report_lag(lag: LagMeter, echo: bool) -> None:
    lines = lag.summary()
    if lines and echo:
        typer.echo("Belt response lag (resolution: one status report):")
    for line in lines:
        if echo:
            typer.echo(f"  {line}")
        log.info("lag summary: %s", line)


@app.command()
def stop(
    address: AddressArg = None,
    fake: FakeOpt = False,
    protocol: ProtocolOpt = None,
    fake_speed: FakeSpeedOpt = 3.0,
    config: ConfigOpt = None,
    time_scale: TimeScaleOpt = 1.0,
) -> None:
    """Stop the belt and wait until it has stopped. Never asks: stopping is always allowed."""
    cfg = load_config(config)
    backend: PadBackend
    if fake:
        backend, clock = _make_fake(fake_speed, time_scale)
    else:
        backend, clock = _make_ble(address, protocol, cfg), MonotonicClock()

    async def run() -> None:
        await backend.connect()
        controller = SpeedController(backend, cfg.safety, clock)
        try:
            await _first_sample(backend)  # know the belt state, so we can tell when it stopped
            await controller.stop(client=CLIENT)
            if await _print_until_stopped(backend, controller):
                typer.echo("Belt stopped.")
        finally:
            await controller.close()

    try:
        asyncio.run(run())
    except BackendError as exc:
        typer.echo(f"Error: {exc}", err=True)
        raise typer.Exit(1) from exc


@app.command()
def serve(
    address: AddressArg = None,
    fake: FakeOpt = False,
    protocol: ProtocolOpt = None,
    host: Annotated[str | None, typer.Option(help="Listen address. Default: [server] host.")] = None,
    port: Annotated[int | None, typer.Option(help="Listen port. Default: [server] port.")] = None,
    fake_speed: FakeSpeedOpt = 0.0,
    config: ConfigOpt = None,
) -> None:
    """Run the bridge service: live WebSocket, sessions, stats, LAN-only control, the web app.

    Keeps running when the pad is off or taken by the phone app, and reconnects when it can.
    """
    import uvicorn  # noqa: PLC0415  (only the service needs it)

    from .server import create_app  # noqa: PLC0415
    from .service import BridgeService  # noqa: PLC0415
    from .storage import Store  # noqa: PLC0415

    cfg = load_config(config)
    backend: PadBackend
    if fake:
        backend, _ = _make_fake(fake_speed, 1.0)
        protocol_name = "fake"
    else:
        backend = _make_ble(address, protocol, cfg)
        protocol_name = None
    store = Store(cfg.storage.db_file())
    service = BridgeService(backend, cfg, store, protocol_name=protocol_name)
    listen_host = host or cfg.server.host
    listen_port = port or cfg.server.port
    typer.echo(
        f"Serving on http://{listen_host}:{listen_port} (database {cfg.storage.db_file()}). "
        "Ctrl+C stops the belt and exits."
    )
    try:
        uvicorn.run(create_app(service, cfg), host=listen_host, port=listen_port, log_config=None)
    finally:
        store.close()
