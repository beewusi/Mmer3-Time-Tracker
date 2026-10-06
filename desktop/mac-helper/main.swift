// Mmer3 Wi-Fi check (Mac only). macOS only shows the Wi-Fi router's ID to
// apps allowed Location, and won't ask on behalf of a script, so this small
// app asks for itself. It writes three lines to the file it's given:
// router ID, Wi-Fi name, Location status (0 not asked, 2 denied, 3/4 allowed),
// then quits. The position itself isn't read or kept.
import AppKit
import CoreLocation
import CoreWLAN

let outPath = CommandLine.arguments.dropFirst().last(where: { $0.hasPrefix("/") })
    ?? NSTemporaryDirectory() + "mmer3-wifi.txt"

func finish() {
    var router = ""
    var name = ""
    if let wifi = CWWiFiClient.shared().interface() {
        router = wifi.bssid() ?? ""
        name = wifi.ssid() ?? ""
    }
    let status = CLLocationManager.authorizationStatus().rawValue
    try? "\(router)\n\(name)\n\(status)\n".write(toFile: outPath, atomically: true, encoding: .utf8)
    exit(0)
}

class Asker: NSObject, CLLocationManagerDelegate {
    let manager = CLLocationManager()

    func start() {
        manager.delegate = self
        if CLLocationManager.authorizationStatus() == .notDetermined {
            // first time: the Mac shows "… would like to use your location"
            manager.requestWhenInUseAuthorization()
            manager.startUpdatingLocation()
        } else {
            finish()
        }
    }

    // answered (newer and older macOS)
    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        if CLLocationManager.authorizationStatus() != .notDetermined { finish() }
    }
    func locationManager(_ m: CLLocationManager, didChangeAuthorization status: CLAuthorizationStatus) {
        if status != .notDetermined { finish() }
    }
    func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) { finish() }
    func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        if CLLocationManager.authorizationStatus() != .notDetermined { finish() }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // no Dock icon
let asker = Asker()
DispatchQueue.main.async { asker.start() }
// not answered within a minute: write what there is and quit
DispatchQueue.main.asyncAfter(deadline: .now() + 60) { finish() }
app.run()
