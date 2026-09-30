"""Command-line interface: `walkpad-bridge live|speed|stop --fake`."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import signal
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Annotated

import typer

from .backend import BeltState, PadBackend, Sample
from .clock import Clock, MonotonicClock, ScaledClock
from .config import load_config
from .fake import FakeBackend
from .safety import SpeedController

CLIENT = "cli"
STOP_CONFIRM_TIMEOUT_S = 30.0

app = typer.Typer(no_args_is_help=True, help="WalkPad bridge.")

FakeOpt = Annotated[
    bool, typer.Option("--fake", help="Use the simulated pad (required until the BLE backend lands).")
]
FakeSpeedOpt = Annotated[
    float, typer.Option(help="FAKE only: speed the simulated pad is already walking at (0 = stopped).")
]
TimeScaleOpt = Annotated[float, typer.Option(hidden=True, help="FAKE only: run time faster.")]
ConfigOpt = Annotated[Path | None, typer.Option(help="Config file (default: bridge/config.toml).")]


@app.callback()
def main(verbose: Annotated[bool, typer.Option("--verbose", "-v")] = False) -> None:
    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING, format="%(levelname)s %(message)s"
    )


def format_sample(s: Sample) -> str:
    minutes, seconds = divmod(int(s.elapsed_s), 60)
    return (
        f"{s.speed_kmh:4.1f} km/h | {s.distance_m:8.1f} m | {s.steps:6d} steps | "
        f"{minutes:02d}:{seconds:02d} | {s.belt}"
    )


def _make_backend(fake: bool, fake_speed: float, time_scale: float) -> tuple[PadBackend, Clock]:
    if not fake:
        typer.echo("Only --fake is supported until the BLE backend lands.", err=True)
        raise typer.Exit(2)
    clock: Clock = MonotonicClock() if time_scale == 1 else ScaledClock(time_scale)
    return FakeBackend(initial_speed_kmh=fake_speed, clock=clock), clock


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
def live(
    fake: FakeOpt = False,
    count: Annotated[int | None, typer.Option(help="Stop after N samples.")] = None,
    fake_speed: FakeSpeedOpt = 3.0,
    time_scale: TimeScaleOpt = 1.0,
) -> None:
    """Print live samples (read-only; never controls the belt)."""
    backend, _ = _make_backend(fake, fake_speed, time_scale)

    async def run() -> None:
        await backend.connect()
        try:
            await _print_samples(backend, count)
        finally:
            await backend.disconnect()

    asyncio.run(run())


@app.command()
def speed(
    kmh: Annotated[float, typer.Argument(help="Target speed in km/h (clamped to the safety cap).")],
    fake: FakeOpt = False,
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
    backend, clock = _make_backend(fake, fake_speed, time_scale)

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
    fake: FakeOpt = False,
    fake_speed: FakeSpeedOpt = 3.0,
    config: ConfigOpt = None,
    time_scale: TimeScaleOpt = 1.0,
) -> None:
    """Stop the belt and wait until it has stopped."""
    cfg = load_config(config)
    backend, clock = _make_backend(fake, fake_speed, time_scale)

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
