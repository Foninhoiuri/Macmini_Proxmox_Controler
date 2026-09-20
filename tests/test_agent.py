import importlib.util
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("agent", Path(__file__).parents[1] / "agent/agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class AgentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.sys = self.root / "sys"
        self.mon = self.sys / "class/hwmon/hwmon0"
        self.mon.mkdir(parents=True)
        for name, value in {"name":"applesmc", "temp1_label":"TC0P", "temp1_input":"50000", "fan1_input":"1800", "fan1_min":"1800", "fan1_max":"5500", "fan1_manual":"0", "fan1_output":"1800"}.items():
            (self.mon / name).write_text(value)
        cpu = self.sys / "devices/system/cpu/intel_pstate"
        cpu.mkdir(parents=True)
        (cpu / "no_turbo").write_text("0")
        (cpu / "max_perf_pct").write_text("100")
        self.hardware = agent.Hardware(self.sys, self.root / "state")

    def tearDown(self):
        self.temp.cleanup()

    def command(self, action, args):
        return {"id":"test","action":action,"args":args,"expires":time.time()*1000+20000}

    def test_temperature_and_capabilities(self):
        t = self.hardware.telemetry()
        self.assertEqual(t["temperatures"][0]["value"], 50)
        self.assertTrue(t["capabilities"]["fan"])
        self.assertTrue(t["capabilities"]["cpu"])

    def test_fan_curve_preserves_firmware_and_restores(self):
        self.hardware.set_fan_profile("cool")
        self.assertGreater(int((self.mon / "fan1_min").read_text()),1800)
        self.assertEqual((self.mon / "fan1_manual").read_text(),"0")
        self.hardware.restore()
        self.assertEqual((self.mon / "fan1_min").read_text(),"1800")

    def test_no_sensor_forces_maximum(self):
        self.hardware.set_fan_profile("balanced")
        (self.mon / "temp1_input").unlink()
        self.hardware.thermal_tick()
        self.assertEqual((self.mon / "fan1_min").read_text(),"5500")
        self.assertIsNotNone(self.hardware.problem)
        self.assertTrue(self.hardware.telemetry()["capabilities"]["fan"])
        self.hardware.set_fan_profile("automatic")
        self.assertEqual((self.mon / "fan1_min").read_text(),"1800")

    def test_legacy_applesmc_device_directory(self):
        self.mon.rename(self.root/"saved")
        self.mon.mkdir()
        (self.root/"saved").rename(self.mon/"device")
        self.assertEqual(len(self.hardware.fans()),1)
        self.assertEqual(self.hardware.temperatures()[0]["value"],50)

    def test_maximum_expires_locally(self):
        self.hardware.set_fan_profile("maximum")
        self.hardware.maximum_until=0
        self.hardware.thermal_tick()
        self.assertEqual(self.hardware.profile,"balanced")

    def test_cpu_restores_across_process_restart(self):
        self.hardware.execute(self.command("cpu.profile",{"profile":"eco"}))
        path=self.hardware.cpu_path() / "no_turbo"
        self.assertEqual(path.read_text(),"1")
        fresh=agent.Hardware(self.sys,self.root / "state")
        fresh.restore()
        self.assertEqual(path.read_text(),"0")
        self.assertEqual((fresh.cpu_path() / "max_perf_pct").read_text(),"100")

    def test_rejects_arbitrary_and_expired_commands(self):
        with self.assertRaises(ValueError):
            self.hardware.execute(self.command("shell",{"command":"reboot"}))
        command=self.command("cpu.profile",{"profile":"eco"})
        command["expires"]=0
        with self.assertRaises(ValueError):
            self.hardware.execute(command)

    def test_protected_usb_and_path_traversal(self):
        usb=self.sys / "bus/usb/devices/1-1"
        usb.mkdir(parents=True)
        (usb/"idVendor").write_text("abcd")
        (usb/"bDeviceClass").write_text("08")
        (usb/"power").mkdir()
        (usb/"power/control").write_text("on")
        self.assertFalse(self.hardware.usbs()[0]["controllable"])
        for identifier in ("1-1","../../etc"):
            with self.assertRaises(ValueError):
                self.hardware.execute(self.command("usb.autosuspend",{"id":identifier,"mode":"auto"}))

    def test_inventory_detects_changes_missing_and_nested(self):
        code=self.root/"code";code.mkdir()
        config=self.root/"config";config.mkdir()
        file=code/"agent.py";file.write_text("original")
        state=self.root/"state";state.mkdir()
        agent.atomic_json(state/"manifest.json",{"files":{str(file):agent.hashlib.sha256(file.read_bytes()).hexdigest()}})
        with patch.object(agent,"CODE",code),patch.object(agent,"CONFIG",config/"agent.json"):
            self.hardware.last_scan=-100
            self.assertEqual(self.hardware.inventory()[0]["status"],"ok")
            file.write_text("changed")
            (code/"extra").mkdir()
            (code/"extra"/"unknown").write_text("new")
            self.hardware.last_scan=-100
            result=self.hardware.inventory()
            self.assertEqual(result[0]["status"],"modified")
            self.assertTrue(any(x["path"].endswith("unknown") for x in result))
            file.unlink();self.hardware.last_scan=-100
            self.assertEqual(self.hardware.inventory()[0]["status"],"missing")

    def test_restore_does_not_touch_unmanaged_fan(self):
        (self.mon / "fan1_manual").write_text("1")
        self.hardware.restore()
        self.assertEqual((self.mon / "fan1_manual").read_text(),"1")

if __name__ == "__main__":
    unittest.main()
