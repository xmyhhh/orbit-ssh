package app

import (
	"encoding/binary"
	"reflect"
	"testing"
	"unicode/utf16"
)

func TestWSLNames(t *testing.T) {
	text := "\ufeff测试 Linux\r\nUbuntu\r\nDebian\r\nUbuntu\r\n\r\n"
	want := []string{"测试 Linux", "Ubuntu", "Debian"}
	units := utf16.Encode([]rune(text))
	wide := make([]byte, len(units)*2)
	for i, unit := range units {
		binary.LittleEndian.PutUint16(wide[i*2:], unit)
	}
	for _, data := range [][]byte{[]byte(text), wide, wide[2:]} {
		if got := wslNames(data); !reflect.DeepEqual(got, want) {
			t.Fatalf("unexpected WSL distribution names: %#v", got)
		}
	}
	if names := wslNames(nil); len(names) != 0 {
		t.Fatalf("empty list decoded as %#v", names)
	}
}
