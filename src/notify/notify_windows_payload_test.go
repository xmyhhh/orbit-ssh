package notify

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/xml"
	"strings"
	"testing"
	"unicode/utf16"
)

func decodeWindowsToastCommand(t *testing.T, command string) string {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(command)
	if err != nil {
		t.Fatal(err)
	}
	if len(data)%2 != 0 {
		t.Fatal("EncodedCommand has an incomplete UTF-16 code unit")
	}
	units := make([]uint16, len(data)/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(data[2*i:])
	}
	return string(utf16.Decode(units))
}

func TestWindowsPowerShellCommandEncoding(t *testing.T) {
	const script = "$title = '审批 café 😀'; Write-Output $title"
	command := encodePowerShellCommand(script)
	data, err := base64.StdEncoding.DecodeString(command)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 2 || data[0] != '$' || data[1] != 0 {
		t.Fatalf("command does not start with BOM-free UTF-16LE: %x", data)
	}
	if got := decodeWindowsToastCommand(t, command); got != script {
		t.Fatalf("Unicode script did not round-trip: got %q, want %q", got, script)
	}
}

func TestWindowsToastPayloadIsData(t *testing.T) {
	tests := []struct {
		name  string
		title string
		body  string
	}{
		{"ordinary", "Approval needed", "ssh production uptime"},
		{"unicode", "审批请求 😀", "服务器 café — 実行許可 🚀"},
		{"xml", `<title & "quote">`, `</text><actions><action content="approve"/></actions><text>'&`},
		{"here-string", "approval", "preview\r\n'@\r\nthrow 'injected'\r\n#"},
		{"expressions", "$(throw 'title')", "`\"; $(Start-Process calc.exe); #\n@'\n'@"},
		{"placeholder", "__XML_BASE64__", "__TITLE__ __BODY__"},
		{"empty", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			script := decodeWindowsToastCommand(t, windowsToastEncodedCommand(tt.title, tt.body, "request"))
			template := strings.Replace(windowsToastScript, "__TAG__", windowsToastTag("request"), 1)
			parts := strings.Split(template, "__XML_BASE64__")
			if len(parts) != 2 || !strings.HasPrefix(script, parts[0]) || !strings.HasSuffix(script, parts[1]) {
				t.Fatal("untrusted content changed the PowerShell script structure")
			}
			encodedXML := strings.TrimSuffix(strings.TrimPrefix(script, parts[0]), parts[1])
			data, err := base64.StdEncoding.DecodeString(encodedXML)
			if err != nil {
				t.Fatalf("script argument is not strictly base64 data: %v", err)
			}
			if got := string(data); got != windowsToastXML(tt.title, tt.body) {
				t.Fatalf("XML did not round-trip: %q", got)
			}
			var toast struct {
				XMLName xml.Name   `xml:"toast"`
				Texts   []string   `xml:"visual>binding>text"`
				Actions []struct{} `xml:"actions"`
			}
			if err := xml.Unmarshal(data, &toast); err != nil {
				t.Fatalf("invalid toast XML: %v", err)
			}
			if len(toast.Texts) != 2 || toast.Texts[0] != tt.title || toast.Texts[1] != tt.body {
				t.Fatalf("text did not round-trip: %#v", toast.Texts)
			}
			if len(toast.Actions) != 0 {
				t.Fatal("untrusted preview created toast actions")
			}
		})
	}
}

func TestWindowsToastXMLReplacesInvalidCharacters(t *testing.T) {
	data := windowsToastXML("bad\x00title", "bad\x01body\xff")
	var document struct {
		XMLName xml.Name
	}
	if err := xml.Unmarshal([]byte(data), &document); err != nil {
		t.Fatalf("control characters or invalid UTF-8 made invalid XML: %v", err)
	}
	if strings.ContainsAny(data, "\x00\x01") || strings.Contains(data, "\xff") {
		t.Fatal("invalid XML characters were preserved")
	}
}

func TestWindowsToastScriptReportsFailures(t *testing.T) {
	for _, script := range []string{windowsToastScript, windowsToastRemoveScript} {
		if !strings.Contains(script, "$ErrorActionPreference = 'Stop'") {
			t.Fatal("PowerShell nonterminating errors must become failures")
		}
		if !strings.Contains(script, "} catch {\n    exit 1\n}") || !strings.HasSuffix(script, "exit 0\n") {
			t.Fatal("PowerShell must explicitly report success and failure exit statuses")
		}
		if strings.Contains(script, "@'") || strings.Contains(script, "@\"") {
			t.Fatal("toast script must not interpolate XML through a here-string")
		}
	}
}

func TestWindowsToastIdentityAndExpiry(t *testing.T) {
	seen := make(map[string]bool)
	for _, requestID := range []string{"", "request-1", "request-2", "审批 😀", "'\nthrow 'injected'\n# __TAG__"} {
		tag := windowsToastTag(requestID)
		if len(tag) != 16 || strings.Trim(tag, "0123456789abcdef") != "" {
			t.Fatalf("tag must be 16 safe ASCII hex characters: %q", tag)
		}
		if tag != windowsToastTag(requestID) || seen[tag] {
			t.Fatalf("tag is unstable or duplicated for distinct test IDs: %q", tag)
		}
		seen[tag] = true
		posted := decodeWindowsToastCommand(t, windowsToastEncodedCommand("title", "body", requestID))
		if !strings.Contains(posted, "$toast.Tag = '"+tag+"'") || !strings.Contains(posted, "$toast.Group = 'OrbitSSH'") {
			t.Fatal("posted toast does not have the expected request identity")
		}
		if !strings.Contains(posted, "$toast.ExpirationTime = [DateTimeOffset]::Now.AddMinutes(2)") {
			t.Fatal("posted toast must expire after two minutes")
		}
		removed := decodeWindowsToastCommand(t, windowsToastRemoveEncodedCommand(requestID))
		want := strings.Replace(windowsToastRemoveScript, "__TAG__", tag, 1)
		if removed != want {
			t.Fatal("request ID changed the withdrawal script structure")
		}
		if !strings.Contains(removed, "::History.Remove('"+tag+"', 'OrbitSSH', '"+windowsToastAppID+"')") {
			t.Fatal("withdrawal must target the same tag, group, and AppID")
		}
		if !strings.Contains(posted, "::CreateToastNotifier('"+windowsToastAppID+"')") {
			t.Fatal("posting and removal must use the same AppID")
		}
	}
}
