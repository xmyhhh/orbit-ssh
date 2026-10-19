package main

import (
	"bytes"
	"encoding/base64"
	"io"
	"testing"
)

type finalTerminalChunk []byte

func (chunk finalTerminalChunk) Read(buffer []byte) (int, error) {
	return copy(buffer, chunk), io.EOF
}

func TestTerminalOutputEmitsFinalBytes(t *testing.T) {
	data := []byte("最后一段🙂\r\n")
	output := &terminalOutputBuffer{}
	var received []byte
	a := NewApp()
	a.emit = func(name string, args ...interface{}) {
		if name != "ssh:data:terminal" {
			t.Fatalf("output routed to %s", name)
		}
		chunk, err := base64.StdEncoding.DecodeString(args[0].(string))
		if err != nil {
			t.Fatal(err)
		}
		received = append(received, chunk...)
	}
	a.copyTerminalOutput("terminal", output, finalTerminalChunk(data))
	if !bytes.Equal(output.read(), data) || !bytes.Equal(received, data) {
		t.Fatalf("last output chunk lost: retained=%q emitted=%q", output.read(), received)
	}
}

func TestTerminalOutputKeepsBoundedIndependentSnapshots(t *testing.T) {
	output := &terminalOutputBuffer{}
	output.append(bytes.Repeat([]byte("a"), terminalOutputLimit+100))
	output.append([]byte("tail"))
	first := output.read()
	if len(first) != terminalOutputLimit || !bytes.HasSuffix(first, []byte("tail")) {
		t.Fatal("terminal output was not bounded or lost recent bytes")
	}
	first[len(first)-1] = '!'
	if bytes.HasSuffix(output.read(), []byte("!")) {
		t.Fatal("a caller mutated the terminal's stored output")
	}
}
