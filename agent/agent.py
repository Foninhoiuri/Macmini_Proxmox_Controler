#!/usr/bin/env python3
"""Mac mini Controller: outbound agent, Python standard library only."""
import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

VERSION = "0.1.0"
CONFIG = Path("/etc/macmini-controller/agent.json")
STATE = Path("/var/lib/macmini-controller")
CODE = Path("/opt/macmini-controller")
UNIT = Path("/etc/systemd/system/macmini-controller.service")
MODULE = Path("/etc/modules-load.d/macmini-controller.conf")
STOP = threading.Event()


def read(path, default=""):
    try:
        return Path(path).read_text().strip()
    except (OSError, UnicodeError):
        return default


def number(path):
    try:
        return int(read(path))
    except ValueError:
        return None


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=".write-")
    try:
        os.chmod(temporary, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=4, check=True)
    return result.stdout.strip()


class Hardware:
    def __init__(self, sysroot=Path("/sys"), state=STATE):
        self.sys = Path(sysroot)
        self.state = Path(state)
        self.lock = threading.RLock()
        self.profile = "automatic"
        self.cpu_profile = "original"
        self.maximum_until = 0
        self.problem = None
        self.original_file = self.state / "original.json"
        self.original = json.loads(read(self.original_file, "{}"))
        self.fan_base = {}
        self.last_inventory = []
        self.last_scan = 0

    def hwmons(self):
        candidates = []
        for directory in sorted((self.sys / "class/hwmon").glob("hwmon*")):
            candidates.extend([directory, directory / "device"])
        candidates.extend((self.sys / "devices/platform").glob("applesmc.*"))
        seen, result = set(), []
        for directory in candidates:
            resolved = directory.resolve()
            if resolved not in seen and read(directory / "name") in ("applesmc", "coretemp"):
                seen.add(resolved)
                result.append(directory)
        return result

    def fan_devices(self):
        devices = []
        for directory in self.hwmons():
            if read(directory / "name") != "applesmc":
                continue
            for source in sorted(directory.glob("fan*_input")):
                stem = source.name.removesuffix("_input")
                devices.append((directory, stem))
        return devices

    def temperatures(self):
        result = []
        for directory in self.hwmons():
            driver = read(directory / "name")
            if driver not in ("applesmc", "coretemp"):
                continue
            for source in sorted(directory.glob("temp*_input")):
                value = number(source)
                if value is None or value <= 0 or value > 150000:
                    continue
                label = read(source.with_name(source.name.replace("_input", "_label")), source.stem)
                stable = hashlib.sha256((driver + label + source.name).encode()).hexdigest()[:12]
                result.append({"id": stable, "label": driver + " · " + label, "value": round(value / 1000, 1), "driver": driver})
        return result

    def fans(self):
        result = []
        for directory, stem in self.fan_devices():
            minimum, maximum = number(directory / (stem + "_min")), number(directory / (stem + "_max"))
            valid = minimum is not None and maximum is not None and 0 < minimum <= maximum <= 10000
            controllable = valid and all(os.access(directory / (stem + suffix), os.W_OK) for suffix in ("_min", "_manual", "_output"))
            result.append({"id": stem, "rpm": number(directory / (stem + "_input")), "min": minimum, "max": maximum, "controllable": controllable})
        return result

    def write(self, path, value):
        Path(path).write_text(str(value))

    def remember(self, path):
        resolved = str(Path(path).resolve())
        # Resolve sysfs links so the saved setting survives changing hwmon indices.
        if resolved not in self.original:
            self.original[resolved] = read(path)
            atomic_json(self.original_file, self.original)

    def restore(self):
        errors = []
        with self.lock:
            for target, value in list(self.original.items()):
                path = Path(target)
                try:
                    if not path.is_relative_to(self.sys.resolve()) or not path.exists():
                        raise RuntimeError("Caminho original indisponível")
                    self.write(path, value)
                    del self.original[target]
                except Exception as error:
                    errors.append(str(path) + ": " + str(error))
            # Release all currently visible fans even if indices changed after reboot.
            for directory, stem in self.fan_devices() if self.profile != "automatic" else []:
                try:
                    self.write(directory / (stem + "_manual"), 0)
                except OSError as error:
                    errors.append(str(error))
            atomic_json(self.original_file, self.original)
            self.profile = "automatic"
            self.cpu_profile = "original"
            audio_original = self.state / "audio-original.json"
            if audio_original.exists():
                try:
                    saved = json.loads(audio_original.read_text())
                    if saved["control"] not in ("Master", "Speaker") or type(saved["volume"]) is not int or not 0 <= saved["volume"] <= 100:
                        raise ValueError("Estado de áudio original inválido")
                    run(["amixer", "sset", saved["control"], str(saved["volume"]) + "%", "mute" if saved.get("muted") else "unmute"])
                    audio_original.unlink()
                except Exception as error:
                    errors.append("Áudio: " + str(error))
        if errors:
            raise RuntimeError("; ".join(errors))

    def fan_auto(self):
        for directory, stem in self.fan_devices():
            minimum = directory / (stem + "_min")
            original = self.original.get(str(minimum.resolve()))
            if original is not None:
                self.write(minimum, original)
            self.write(directory / (stem + "_manual"), 0)
        self.profile = "automatic"

    def set_fan_profile(self, profile):
        if profile not in ("automatic", "balanced", "cool", "maximum"):
            raise ValueError("Perfil térmico inválido")
        if not self.fans() or not all(f["controllable"] for f in self.fans()):
            raise ValueError("SMC não oferece controle seguro")
        if profile == "automatic":
            self.fan_auto()
            return
        # Refuse to compete with a second controller.
        for unit in ("mbpfan", "macfanctld", "macfanpp", "fancontrol"):
            if self.sys == Path("/sys"):
                check = subprocess.run(["systemctl", "is-active", "--quiet", unit], timeout=3)
                if check.returncode == 0:
                    raise ValueError("Outro controlador térmico está ativo: " + unit)
        for directory, stem in self.fan_devices():
            self.remember(directory / (stem + "_min"))
            self.remember(directory / (stem + "_manual"))
        self.profile = profile
        self.maximum_until = time.monotonic() + 300 if profile == "maximum" else 0
        self.thermal_tick()

    def thermal_tick(self):
        with self.lock:
            if self.profile == "automatic":
                return
            if self.profile == "maximum" and time.monotonic() >= self.maximum_until:
                self.profile = "balanced"
            sensors = self.temperatures()
            temps = [s["value"] for s in sensors]
            emergency = not temps or max(temps) >= 85
            self.problem = "Sensor indisponível ou temperatura >= 85 °C: resfriamento máximo." if emergency else None
            for directory, stem in self.fan_devices():
                maximum = number(directory / (stem + "_max"))
                current_min = number(directory / (stem + "_min"))
                baseline = self.original.get(str((directory / (stem + "_min")).resolve()), str(current_min))
                minimum = int(baseline)
                if not maximum or not 0 < minimum < maximum <= 10000:
                    self.fan_auto()
                    raise ValueError("Limites SMC inválidos; modo automático restaurado")
                if emergency or self.profile == "maximum":
                    target = maximum
                else:
                    start, end = (40, 70) if self.profile == "cool" else (45, 78)
                    factor = min(1, max(0, (max(temps) - start) / (end - start)))
                    target = round(minimum + (maximum - minimum) * factor)
                # Increase the minimum, not a fixed manual RPM: firmware retains authority.
                self.write(directory / (stem + "_manual"), 0)
                self.write(directory / (stem + "_min"), max(minimum, min(target, maximum)))

    def cpu_path(self):
        return self.sys / "devices/system/cpu/intel_pstate"

    def set_cpu(self, profile):
        if profile not in ("original", "eco", "balanced", "performance"):
            raise ValueError("Perfil de energia inválido")
        paths = [self.cpu_path() / "no_turbo", self.cpu_path() / "max_perf_pct"]
        if not all(p.exists() and os.access(p, os.W_OK) for p in paths):
            raise ValueError("Intel P-state não disponível")
        for path in paths:
            self.remember(path)
        values = [self.original[str(p.resolve())] for p in paths] if profile == "original" else {"eco": [1, 60], "balanced": [0, 85], "performance": [0, 100]}[profile]
        for path, value in zip(paths, values):
            self.write(path, value)
        self.cpu_profile = profile

    def radios(self):
        return [{"id": p.name, "name": read(p / "name"), "type": "wifi" if read(p / "type") == "wlan" else read(p / "type"),
                 "blocked": read(p / "soft") == "1" or read(p / "hard") == "1", "hardBlocked": read(p / "hard") == "1"}
                for p in sorted((self.sys / "class/rfkill").glob("rfkill*")) if read(p / "type") in ("wlan", "bluetooth")]

    def usbs(self):
        result = []
        root = self.sys / "bus/usb/devices"
        for p in sorted(root.glob("*")):
            if ":" in p.name or not (p / "idVendor").exists():
                continue
            classes = {read(p / "bDeviceClass").lower()}
            classes.update(read(i / "bInterfaceClass").lower() for i in root.glob(p.name + ":*"))
            # Storage, hubs, network, composite/vendor-specific devices stay protected.
            protected = bool(classes & {"08", "09", "02", "0a", "ef", "ff"})
            result.append({"id": p.name, "name": read(p / "product", p.name), "vendor": read(p / "idVendor"),
                           "mode": read(p / "power/control"), "controllable": not protected and os.access(p / "power/control", os.W_OK)})
        return result

    def audio(self):
        if self.sys != Path("/sys") or not shutil.which("amixer"):
            return None
        try:
            names = run(["amixer", "scontrols"])
            control = next((name for name in ("Master", "Speaker") if "'" + name + "'" in names), None)
            if not control:
                return None
            output = run(["amixer", "sget", control])
            match = re.search(r"\[(\d+)%\]", output)
            return {"control": control, "volume": int(match.group(1)) if match else None, "muted": "[off]" in output}
        except (subprocess.SubprocessError, OSError):
            return None

    def inventory(self):
        if time.monotonic() - self.last_scan < 30:
            return self.last_inventory
        self.last_scan = time.monotonic()
        manifest = json.loads(read(self.state / "manifest.json", '{"files":{}}'))
        expected = manifest.get("files", {})
        result = []
        for name, digest in expected.items():
            file = Path(name)
            try:
                actual = hashlib.sha256(file.read_bytes()).hexdigest()
                status = "ok" if actual == digest else "modified"
                result.append({"path": name, "status": status, "size": file.stat().st_size})
            except OSError:
                result.append({"path": name, "status": "missing", "size": 0})
        for directory in (CODE, CONFIG.parent):
            if not directory.exists():
                continue
            for parent, dirs, files in os.walk(directory, followlinks=False):
                for name in dirs + files:
                    file = Path(parent) / name
                    if str(file) not in expected:
                        result.append({"path": str(file), "status": "unexpected", "size": 0})
                    if len(result) >= 299:
                        break
                if len(result) >= 299:
                    break
        self.last_inventory = result[:299]
        return self.last_inventory

    def telemetry(self):
        fans, radios, usbs, audio = self.fans(), self.radios(), self.usbs(), self.audio()
        cpu = self.cpu_path()
        return {
            "version": VERSION, "model": read(self.sys / "class/dmi/id/product_name", "Mac mini"),
            "temperatures": self.temperatures(), "fans": fans, "radios": radios, "usb": usbs, "audio": audio,
            "fanProfile": self.profile, "cpuProfile": self.cpu_profile, "thermalWarning": self.problem,
            "cpu": {"noTurbo": number(cpu / "no_turbo"), "maxPerformance": number(cpu / "max_perf_pct")},
            "capabilities": {
                "fan": bool(fans) and all(f["controllable"] for f in fans),
                "cpu": all(os.access(cpu / name, os.W_OK) for name in ("no_turbo", "max_perf_pct")),
                "radios": bool(radios), "usb": any(d["controllable"] for d in usbs), "audio": audio is not None,
            },
            "inventory": self.inventory(),
            "installation": {"code": str(CODE), "config": str(CONFIG), "state": str(self.state), "service": str(UNIT), "scanSeconds": 30},
            "diagnostics": {
                "sleepStates": read(self.sys / "power/state"),
                "rtcAlarm": (self.sys / "class/rtc/rtc0/wakealarm").exists(),
                "efi": (self.sys / "firmware/efi/efivars").exists(),
                "powercap": [p.name for p in (self.sys / "class/powercap").glob("*")],
            },
        }

    def execute(self, command):
        if command.get("expires", 0) < time.time() * 1000:
            raise ValueError("Comando expirado")
        args, action = command.get("args", {}), command.get("action")
        with self.lock:
            if action == "fan.profile":
                self.set_fan_profile(args.get("profile"))
            elif action == "cpu.profile":
                self.set_cpu(args.get("profile"))
            elif action == "radio.set":
                if args.get("radio") not in ("wifi", "bluetooth") or type(args.get("blocked")) is not bool:
                    raise ValueError("Rádio inválido")
                targets = [r for r in self.radios() if r["type"] == args["radio"]]
                if not targets:
                    raise ValueError("Rádio não encontrado")
                for target in targets:
                    path = self.sys / "class/rfkill" / target["id"] / "soft"
                    self.remember(path)
                    self.write(path, int(args["blocked"]))
            elif action == "usb.autosuspend":
                target = next((d for d in self.usbs() if d["id"] == args.get("id") and d["controllable"]), None)
                if not target or args.get("mode") not in ("auto", "on"):
                    raise ValueError("USB protegido ou opção inválida")
                path = self.sys / "bus/usb/devices" / target["id"] / "power/control"
                self.remember(path)
                self.write(path, args["mode"])
            elif action == "audio.volume":
                volume = args.get("volume")
                if type(volume) is not int or not 0 <= volume <= 100:
                    raise ValueError("Volume inválido")
                audio = self.audio()
                if not audio:
                    raise ValueError("Áudio não disponível")
                if audio["volume"] is not None and not (self.state / "audio-original.json").exists():
                    atomic_json(self.state / "audio-original.json", audio)
                run(["amixer", "sset", audio["control"], str(volume) + "%"])
            else:
                raise ValueError("Ação não permitida")
        return "Aplicado no host"


def request(config, route, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(config["url"] + route, data=data, headers={
        "Authorization": "Bearer " + config["token"], "Content-Type": "application/json",
    })
    # Never follow a redirect carrying the agent token.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    with urllib.request.build_opener(NoRedirect).open(req, timeout=8) as response:
        return json.loads(response.read(512000))


def create_manifest():
    files = [CODE / "agent.py", CODE / "uninstall.sh", CONFIG, UNIT, MODULE]
    atomic_json(STATE / "manifest.json", {"version": VERSION, "installed": time.time(), "files": {
        str(file): hashlib.sha256(file.read_bytes()).hexdigest() for file in files
    }})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--enroll", action="store_true")
    parser.add_argument("--manifest", action="store_true")
    parser.add_argument("--restore", action="store_true")
    parser.add_argument("--inspect", action="store_true")
    args = parser.parse_args()
    if args.manifest:
        create_manifest()
        return
    hardware = Hardware()
    if args.inspect:
        print(json.dumps(hardware.telemetry(), indent=2))
        return
    if args.restore:
        hardware.restore()
        return
    config = json.loads(CONFIG.read_text())
    if args.enroll:
        result = request(config, "/agent/enroll", {"name": socket.gethostname()})
        config.update({"token": result["token"], "id": result["id"]})
        atomic_json(CONFIG, config)
        return
    # A crash or reboot must not leave a previous tuning session active.
    hardware.restore()
    for event in (signal.SIGTERM, signal.SIGINT):
        signal.signal(event, lambda *_: STOP.set())

    thermal_failed = threading.Event()
    def thermal_loop():
        while not STOP.wait(2):
            try:
                hardware.thermal_tick()
            except Exception as error:
                hardware.problem = str(error)
                print("thermal:", error, flush=True)
                # Force restart and ExecStopPost restoration if sysfs became unwritable.
                thermal_failed.set()
                STOP.set()
    worker = threading.Thread(target=thermal_loop, daemon=True)
    worker.start()
    results, done = [], set()
    try:
        while not STOP.is_set():
            try:
                reply = request(config, "/agent/heartbeat", {"telemetry": hardware.telemetry(), "results": results})
                results = []
                for command in reply.get("commands", []):
                    cid = command.get("id")
                    if not isinstance(cid, str) or cid in done:
                        continue
                    # At-most-once dispatch: lost responses are shown as unknown in UI.
                    done.add(cid)
                    try:
                        message = hardware.execute(command)
                        results.append({"id": cid, "ok": True, "message": message})
                    except Exception as error:
                        results.append({"id": cid, "ok": False, "message": str(error)[:500]})
                if len(done) > 10000:
                    done = {r["id"] for r in results}
            except urllib.error.HTTPError as error:
                print("controller HTTP:", error.code, flush=True)
                if error.code == 401:
                    STOP.set()
            except Exception as error:
                print("controller unavailable:", type(error).__name__, flush=True)
            STOP.wait(5)
    finally:
        STOP.set()
        worker.join(timeout=5)
        hardware.restore()
    if thermal_failed.is_set():
        raise RuntimeError("Falha no controle térmico: reiniciando o agente")


if __name__ == "__main__":
    main()
