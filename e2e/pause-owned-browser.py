"""Pause only a fixture-owned Linux browser tree; always resume pinned PIDs.

This is process suspension, not device sleep. The separate process is a
watchdog: a dead test runner triggers early resume rather than an orphaned stop.
Requires Linux pidfds and Python >= 3.9. No sudo, shell, or process-name lookup.
"""
import json
import os
from pathlib import Path
import signal
import sys
import time


def identity(proc_pid):
    directory = Path(f'/proc/{proc_pid}')
    # /proc can be mounted in an outer PID namespace (including this sandbox).
    # Match the namespace inode before using NSpid; a numeric suffix alone can
    # collide with a process in an unrelated container.
    if os.readlink(directory / 'ns/pid') != os.readlink('/proc/self/ns/pid'):
        raise ProcessLookupError('Process belongs to another PID namespace')
    status = (directory / 'status').read_text()
    namespace_ids = next(line.split()[1:] for line in status.splitlines() if line.startswith('NSpid:'))
    pid = int(namespace_ids[-1])
    text = (directory / 'stat').read_text()
    fields = text[text.rindex(')') + 2:].split()
    return {'pid': pid, 'procPid': proc_pid, 'state': fields[0], 'parent': int(fields[1]),
            'ticks': int(fields[11]) + int(fields[12]), 'start': fields[19]}


def processes():
    found = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            item = identity(int(entry.name))
            found[item['procPid']] = item
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return found


def descendants(root):
    current = processes()
    selected = {root}
    while True:
        found = {pid for pid, item in current.items() if item['parent'] in selected}
        if found <= selected:
            return [current[pid] for pid in sorted(selected) if pid in current]
        selected |= found


def owned_root(request):
    pid, parent = request['pid'], request['parent']
    if type(pid) is not int or pid <= 1 or pid in (os.getpid(), parent):
        raise ValueError('Invalid fixture browser PID')
    if parent != os.getppid():
        raise ValueError('Watchdog must be a direct child of its test runner')
    profile = Path(request['profile'])
    if not profile.is_absolute() or not profile.is_dir():
        raise ValueError('Expected an existing absolute disposable profile')
    current_processes = processes()
    root = next(item for item in current_processes.values() if item['pid'] == pid)
    runner = next(item for item in current_processes.values() if item['pid'] == parent)
    args = Path(f"/proc/{root['procPid']}/cmdline").read_bytes().split(b'\0')
    expected = str(profile).encode()
    matches = b'--user-data-dir=' + expected in args or any(
        args[i] in (b'--profile', b'-profile') and args[i + 1] == expected
        for i in range(len(args) - 1))
    if not matches:
        raise ValueError('Browser command line does not own the requested profile')
    current = root
    while current['parent'] != runner['procPid']:
        if current['parent'] <= 1:
            raise ValueError('Browser is not a descendant of the test runner')
        current = identity(current['parent'])
    return root


def pause(request):
    if sys.platform != 'linux' or not hasattr(os, 'pidfd_open'):
        raise RuntimeError('Native browser pause requires Linux pidfds')
    duration = request['milliseconds']
    if type(duration) is not int or not 250 <= duration <= 180_000:
        raise ValueError('Pause duration must be an integer in 250..180000 ms')
    root = owned_root(request)
    stopped = {}
    interrupted = []
    report = {'kind': 'native-browser-process-pause', 'deviceSleep': False,
              'root': root, 'requestedMs': duration, 'resumed': []}
    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, lambda number, _frame: interrupted.append(number))
    try:
        setup_end = time.monotonic() + 5
        while True:
            for item in descendants(root['procPid']):
                pid = item['pid']
                if pid in stopped or item['state'] == 'Z':
                    continue
                fd = os.pidfd_open(pid)
                try:
                    if identity(item['procPid'])['start'] != item['start']:
                        raise RuntimeError('Process identity changed before pause')
                    # Record the pinned handle before sending STOP so every
                    # partial failure joins the same unconditional cleanup.
                    stopped[pid] = (fd, item)
                    signal.pidfd_send_signal(fd, signal.SIGSTOP)
                except BaseException:
                    if pid not in stopped:
                        os.close(fd)
                    raise
            states = descendants(root['procPid'])
            live = [item for item in states if item['state'] != 'Z']
            if live and all(item['pid'] in stopped and item['state'] == 'T' for item in live):
                break
            if interrupted or time.monotonic() >= setup_end:
                raise RuntimeError('Browser process tree did not stop completely')
            time.sleep(.01)
        report['fullyStoppedAt'] = time.time_ns() // 1_000_000
        report['stopped'] = live
        print(json.dumps({'event': 'fully-stopped', 'at': report['fullyStoppedAt']}), file=sys.stderr, flush=True)
        start = time.monotonic()
        while time.monotonic() - start < duration / 1000:
            if interrupted or os.getppid() != request['parent']:
                raise RuntimeError('Runner exited or watchdog interrupted; resuming early')
            time.sleep(max(0, min(.1, duration / 1000 - (time.monotonic() - start))))
        after = [identity(item['procPid']) for item in live]
        for before, current in zip(live, after):
            if current['state'] != 'T' or current['start'] != before['start'] or current['ticks'] != before['ticks']:
                raise RuntimeError('A stopped browser process ran or changed identity')
        report['afterHold'] = after
        report['heldMs'] = (time.monotonic() - start) * 1000
        report['beforeResumeAt'] = time.time_ns() // 1_000_000
        report['status'] = 'passed'
    except BaseException as error:
        report['status'] = 'failed'
        report['error'] = f'{type(error).__name__}: {error}'
    finally:
        # Children first, root last; pidfds cannot target a recycled PID.
        for pid, (fd, _item) in reversed(list(stopped.items())):
            try:
                signal.pidfd_send_signal(fd, signal.SIGCONT)
                report['resumed'].append(pid)
            except ProcessLookupError:
                pass
            finally:
                os.close(fd)
        report['resumedAt'] = time.time_ns() // 1_000_000
    return report


if __name__ == '__main__':
    try:
        result = pause(json.load(sys.stdin))
    except Exception as error:
        result = {'status': 'failed', 'error': f'{type(error).__name__}: {error}'}
    print(json.dumps(result), flush=True)
    sys.exit(0 if result['status'] == 'passed' else 1)
