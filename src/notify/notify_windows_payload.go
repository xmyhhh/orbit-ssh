package notify

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/xml"
	"strings"
	"unicode/utf16"
)

// This file deliberately has no OS build constraint so the Windows payload's
// escaping and encoding can be tested without running PowerShell or Windows.
const (
	windowsToastAppID = `{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`
	windowsToastGroup = "OrbitSSH"
)

const windowsToastScript = `
$ErrorActionPreference = 'Stop'
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('__XML_BASE64__')))
    $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
    $toast.Tag = '__TAG__'
    $toast.Group = '` + windowsToastGroup + `'
    $toast.ExpirationTime = [DateTimeOffset]::Now.AddMinutes(2)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('` + windowsToastAppID + `').Show($toast)
} catch {
    exit 1
}
exit 0
`

const windowsToastRemoveScript = `
$ErrorActionPreference = 'Stop'
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.UI.Notifications.ToastNotificationManager]::History.Remove('__TAG__', '` + windowsToastGroup + `', '` + windowsToastAppID + `')
} catch {
    exit 1
}
exit 0
`

func windowsToastTag(requestID string) string {
	// Toast tags have a 16-character limit. A truncated SHA-256 gives a stable
	// tag without exposing request IDs or inserting them into PowerShell source.
	digest := sha256.Sum256([]byte(requestID))
	return hex.EncodeToString(digest[:8])
}

func windowsToastRemoveEncodedCommand(requestID string) string {
	return encodePowerShellCommand(strings.Replace(windowsToastRemoveScript, "__TAG__", windowsToastTag(requestID), 1))
}

func windowsToastXML(title, body string) string {
	var payload strings.Builder
	payload.WriteString(`<toast scenario="reminder"><visual><binding template="ToastGeneric"><text>`)
	// A strings.Builder cannot fail writes. EscapeText also replaces characters
	// forbidden by XML 1.0, keeping arbitrary command previews valid XML.
	_ = xml.EscapeText(&payload, []byte(title))
	payload.WriteString(`</text><text>`)
	_ = xml.EscapeText(&payload, []byte(body))
	payload.WriteString(`</text></binding></visual></toast>`)
	return payload.String()
}

func windowsToastEncodedCommand(title, body, requestID string) string {
	// Encode the entire XML document as data before embedding it in script.
	// XML escaping alone is not a PowerShell quoting boundary: in particular,
	// an untrusted here-string terminator must never become script source.
	payload := base64.StdEncoding.EncodeToString([]byte(windowsToastXML(title, body)))
	script := strings.NewReplacer("__XML_BASE64__", payload, "__TAG__", windowsToastTag(requestID)).Replace(windowsToastScript)
	return encodePowerShellCommand(script)
}

func encodePowerShellCommand(script string) string {
	// Windows PowerShell -EncodedCommand requires UTF-16LE, without a BOM.
	units := utf16.Encode([]rune(script))
	encoded := make([]byte, 2*len(units))
	for i, unit := range units {
		binary.LittleEndian.PutUint16(encoded[2*i:], unit)
	}
	return base64.StdEncoding.EncodeToString(encoded)
}
