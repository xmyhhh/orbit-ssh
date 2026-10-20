package tray

// asset holds the artwork of the tray entry. The module root embeds it from
// the Wails build assets and hands it over before the tray is installed.
var asset []byte

// SetAsset provides the artwork for the tray entry. Windows expects an icon
// file, Linux a PNG and macOS draws its own menu bar icon.
func SetAsset(data []byte) { asset = data }
